"use strict";
const _ = require("lodash");
const assert = require("assert");
const mssql = require("mssql");
const futile = require("@fujitsusweden/futile");
const { promisify } = require("util");

const mssqlHandler = module.exports;
mssqlHandler.mssql = mssql;

const buffer_pause_at_length = 2000;
const buffer_resume_at_length = 200;
const wait_increment_before_rollback = "1 s";

// Initialization
let log = null;
mssqlHandler.init = args => {
  assert(_.isPlainObject(args));
  assert("log" in args);
  assert(_.isObject(args.log));
  for (const lfn of ["debug", "info", "warn", "error", "critical"]) {
    assert(lfn in args.log);
    assert(_.isFunction(args.log[lfn]));
  }
  log = args.log;
};
function ensureInitialized() {
  assert(log, "You need to call mssqlHandler.init({log}) first.");
}

// Internal: Pool management
// =========================

const pool_off_functions = [];
mssqlHandler.beforeExit = () => Promise.all(_.map(_.clone(pool_off_functions), fun => fun()));

const pools = {};
async function getPoolForConfig(config, req) {
  ensureInitialized();
  const key = futile.canonize(config);
  if (key in pools) {
    return pools[key];
  } else {
    await log.debug({ m: "create mssql pool", database: config.database }, req);
    const pool = new mssql.ConnectionPool(config);
    const offreq = futile.reqMock(`off sql pool for ${config.database}`);
    const off = async () => {
      await log.debug({ m: "close mssql pool", database: config.database }, offreq);
      try {
        pool.close();
      } finally {
        delete pools[key];
        _.remove(pool_off_functions, x => x === off);
      }
    };
    pool.on("err", off);
    pool_off_functions.push(off);
    await pool.connect();
    // Test again to avoid race condition.
    if (key in pools) {
      const ret = pools[key];
      await off();
      return ret;
    } else {
      pools[key] = pool;
      return pool;
    }
  }
}

// Querying
// ========

// Internal: Cache of supported sql types, indexed by both lower- and uppercase names
const mssql_types = {};
for (const type in mssql.TYPES) {
  mssql_types[type.toLowerCase()] = mssql.TYPES[type];
  mssql_types[type.toUpperCase()] = mssql.TYPES[type];
}

// Internal: Function to apply parameters to a request object
function _applyRequestParams({ request, types, params }) {
  for (const paramname in params) {
    const value = params[paramname];
    if (_.isArray(value)) {
      // Array parameters can be inserted, but they will be converted to a comma-separated string, *not* to a comma-separated list of values.
      // This is very likely not what the user wants.
      throw futile.err("Paramater value cannot be an array", { paramname });
    }
    if (paramname in types) {
      const typestr = types[paramname].toLowerCase();
      if (typestr in mssql_types) {
        request.input(paramname, mssql_types[typestr], params[paramname]);
      } else {
        throw futile.err("Unknown mssql type", { type: types[paramname] });
      }
    } else {
      request.input(paramname, params[paramname]);
    }
  }
}

// Internal: Helper function to run a database query, given a function that returns a request object.
// This allows the code to be reused both in context.runDbQuery under mssqlHandler.runFuncAsTransaction and in mssqlHandler.runDbQuery.
async function _runDbQuery({ getRequest, query, types, params, req }) {
  ensureInitialized();
  const request = await getRequest();
  _applyRequestParams({ request, types, params });
  try {
    const result = await request.query(query);
    return result.recordsets[0];
  } catch (err) {
    err.query = query;
    try {
      const config = request.parent.config || request.parent._acquiredConfig;
      err.server = config.server;
      err.database = config.database;
    } catch (err2) {
      // Sometimes we can't get to the config. That's OK.
    }
    // params can potentially contain sensitive data, so send it to DEBUG log only.
    await log.debug({ m: "Error when sending SQL query", params, err }, req);
    throw err;
  } finally {
    request.cancel();
  }
}

// Internal: Helper function similar to _runDbQueryAG, except it is an asynchronous generator.
async function* _runDbQueryAG({ getRequest, query, types, params, req }) {
  ensureInitialized();
  // Use the mssql event interface with pausing and expose an asynchronous
  // generator. This enables the consumer to incrementally fetch the query result
  // without overusing RAM.
  const request = await getRequest();
  _applyRequestParams({ request, types, params });

  // Use streaming
  request.stream = true;

  // Buffer control
  const buffer = [];
  let is_paused = false;
  let buffer_callback = null;
  function bufferctl() {
    if (buffer.length > buffer_pause_at_length && !is_paused) {
      request.pause();
      is_paused = true;
    }
    if (buffer.length < buffer_resume_at_length && is_paused) {
      request.resume();
      is_paused = false;
    }
    if (buffer.length && buffer_callback) {
      buffer_callback(true);
      buffer_callback = null;
    }
  }

  // Handle events
  request.on("row", row => {
    buffer.push({ op: "row", row });
    bufferctl();
  });
  request.on("error", err => {
    buffer.push({ op: "err", err });
    bufferctl();
  });
  request.on("done", ignored__result => {
    buffer.push({ op: "done" });
    bufferctl();
  });

  const waitUntilBufferIsNonempty = () =>
    new Promise((resolve, reject) => {
      if (buffer.length) {
        resolve(true);
      } else if (buffer_callback) {
        reject(new Error("This should never happen"));
      } else {
        buffer_callback = resolve;
        bufferctl();
      }
    });

  try {
    // Run query
    request.query(query);

    // Generator
    outer_loop: while (true) {
      // Process for as long as something's available
      while (buffer.length) {
        // First in, first out
        const item = buffer.shift();
        switch (item.op) {
          case "row":
            yield item.row;
            break;
          case "err":
            item.err.query = query;
            try {
              const config = request.parent.config || request.parent._acquiredConfig;
              item.err.server = config.server;
              item.err.database = config.database;
            } catch (err) {
              // Sometimes we can't get to the config. That's OK.
            }
            // params can potentially contain sensitive data, so send it to DEBUG log only.
            /* eslint-disable-next-line no-await-in-loop */
            await log.debug({ m: "Error when sending SQL query", params, err: item.err }, req);
            throw item.err;
          case "done":
            // JavaScript supports breaking to a label but not consecutive breaks.
            break outer_loop;
          default:
            throw new Error("This should never happen");
        }
      }

      /* eslint-disable-next-line no-await-in-loop */
      await waitUntilBufferIsNonempty();
    }
  } finally {
    request.cancel();
  }
}

// Function to execute an SQL query and return its result.
// Takes one argument, an object with options.
// Mandatory options:
//
// - req
//
// - config: The SQL configuration to connect with.
//
// - query: The SQL query to execute.
//
// Optional options:
//
// - params: An object mapping parameter name to value.
//   Parameters are supplied in the query using `@` syntax, for example `WHERE col1 = @param1;`
//
// - types: An object mapping parameter name to SQL type.
//   Most often unnecessary even if parameters are supplied.
mssqlHandler.runDbQuery = ({ config, query, types = {}, params = {}, req }) =>
  _runDbQuery({
    async getRequest() {
      const pool = await getPoolForConfig(config, req);
      return pool.request();
    },
    query,
    types,
    params,
    req,
  });

// Like mssqlHandler.runDbQueryAG, except yield the resulting records one at a time as an asynchronous generator.
mssqlHandler.runDbQueryAG = ({ config, query, types = {}, params = {}, req }) =>
  _runDbQueryAG({
    async getRequest() {
      const pool = await getPoolForConfig(config, req);
      return pool.request();
    },
    query,
    types,
    params,
    req,
  });

// Transactions
// ============

// Function to wrap a function in an SQL transaction.
// Takes a context argument, an object with options.
// Mandatory options:
//
// - req
//
// - config: The SQL configuration to connect with.
//
// - func: The function to run within a transaction.
//   It should be asynchronous and take a context argument, an object containing:
//
//   - req
//
//   - runDbQuery: Just like mssqlHandler.runDbQuery except it does not accept a `config` option and works within the transaction.
//
//   - runDbQueryAG: Just like mssqlHandler.runDbQueryAG except it does not accept a `config` option and works within the transaction.
//
//   - transaction: The native `transaction` object.
//
//   - Any other options passed to mssqlHandler.runFuncAsTransaction.
//
// Optional options:
//
// - Any number of options you want to pass along to func
mssqlHandler.runFuncAsTransaction = async function ({ config, func, req, ...context }) {
  ensureInitialized();
  const pool = await getPoolForConfig(config, req);
  const transaction = await new mssql.Transaction(pool);
  let rolledBack = false;
  transaction.on("rollback", ignored__aborted => {
    // emitted with aborted === true
    rolledBack = true;
  });
  transaction.begin_async = promisify(transaction.begin);
  await transaction.begin_async(mssql.ISOLATION_LEVEL.SNAPSHOT);
  const runDbQuery = ({ query, types = {}, params = {} }) =>
    _runDbQuery({
      getRequest() {
        return transaction.request();
      },
      query,
      types,
      params,
      req,
    });
  const runDbQueryAG = ({ query, types = {}, params = {} }) =>
    _runDbQueryAG({
      getRequest() {
        return transaction.request();
      },
      query,
      types,
      params,
      req,
    });
  try {
    await func({ runDbQuery, runDbQueryAG, transaction, req, ...context });
    await transaction.commit();
  } catch (err) {
    if (rolledBack) {
      await log.error({ message: "Caught error in transaction, which is already rolled back", err }, req);
    } else {
      await log.error({ message: "Caught error in transaction, which will be rolled back", err }, req);
      while (transaction._activeRequest) {
        /* eslint-disable-next-line no-await-in-loop */
        await futile.sleep(wait_increment_before_rollback);
      }
      await transaction.rollback();
      await log.debug({ message: "Transaction rolled back" }, req);
    }
    throw err;
  }
};

// Identifier escaping
// ===================

// Take the name of an identifier (for e.g. a table, column or index) and return it escaped, ready to be used in an SQL statement.
mssqlHandler.escId = id => `[${id.split("]").join("]]")}]`;

// Inverse for mssqlHandler.escId
mssqlHandler.unEscId = function (q_id) {
  if (!q_id.match(/^\[(\]\]|[^\]])+\]$/u)) {
    throw futile.err("unEscId with illegal escaped ID", { q_id });
  }
  return q_id.slice(1, -1).split("]]").join("]");
};
