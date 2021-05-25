# mssql-handler

## What is it

A library for interacting with MS SQL Server, implemented as a convenience wrapper around `mssql`.

## How to use it

This module provides no classes.
You don't need to keep track of connection pools or instances.
Just call the module functions directly with what you need.
Connection pools are created and cached behind the scenes.

### mssqlHandler.init({ log })

Initialize the module.
Example:

```js
const mssqlHandler = require("@fujitsusweden/mssql-handler");
mssqlHandler.init({ log });
```

The `log` is an object holding the following log functions: `debug`, `info`, `warn`, `error` and `critical`.
Each log function should be an async function taking arguments `data` and `req`.

### mssqlHandler.beforeExit()

Close all connection pools.

In scripts that should terminate, call `await mssqlHandler.beforeExit()` at the end.
Otherwise, asynchronous background jobs can prevent the process from terminating indefinitely.

### mssqlHandler.runDbQuery({ config, query, types, params, req })

Execute an SQL query and return its result.
Example:

```js
const results = await mssqlHandler.runDbQuery({
  config: config.db_sql,
  query: "SELECT * FROM people WHERE Name = @name;",
  params: { name: "Joe" },
  req,
});
```

Option details:

* **config**: The SQL configuration to connect with.

* **query**: The SQL query to execute. Use `@` to denote parameters.

* **types**: Optional. Probably never needed. A map from (some of) the parameter names to the name of their type. For the parameters present in `types`, this will override the library's attempt at figuring out a suitable type.

* **params**: Optional. An object mapping parameter names to values.

* **req**: The `req` object used for logging.

### mssqlHandler.runDbQueryAG({ config, query, types, params, req })

Asynchronous generator variant of `mssqlHandler.runDbQuery`, with the same option details.
Example:

```js
for await (const record of mssqlHandler.runDbQueryAG({
  config: config.db_sql,
  query: "SELECT * FROM people WHERE Name = @name;",
  params: { name: "Joe" },
  req,
})) {
  console.log(record);
}
```

### mssqlHandler.runFuncAsTransaction({ config, func, req, ...context })

Execute a function in the context of an SQL transaction.
If the function throws any error, the transaction will be rolled back.
Example:

```js
async function transfer({ runDbQuery, fromAccount, toAccount, amount }) {
  await runDbQuery({
    query: `
      UPDATE accounts
      SET balance = balance - @amount
      WHERE holder = @fromAccount;`,
    params: { amount, fromAccount },
  });
  await runDbQuery({
    query: `
      UPDATE accounts
      SET balance = balance + @amount
      WHERE holder = @toAccount;`,
    params: { amount, toAccount },
  });
  const fromAccountAfterwards = await runDbQuery({
    query: `
      SELECT *
      FROM accounts
      WHERE holder = @fromAccount;`,
    params: { fromAccount },
  });
  // Rollback to prevent overdraft
  assert(0 <= fromAccountAfterwards[0].balance);
}

await mssqlHandler.runFuncAsTransaction({
  config: config.db_sql,
  func: transfer,
  req,
  fromAccount: "Alice",
  toAccount: "Bob",
  amount: 700,
});
```

Option details:

* **config**: The SQL configuration to connect with.

* **func**: The function to run within a transaction.
  It should be asynchronous and take a context argument, an object containing:

   * **req**

   * **runDbQuery**: Just like `mssqlHandler.runDbQuery` except it does not accept a `config` option and works within the transaction.

   * **runDbQueryAG**: Just like `mssqlHandler.runDbQueryAG` except it does not accept a `config` option and works within the transaction.

   * **transaction**: The native `transaction` object. You probably don't need that.

   * **...context**: Any other options passed to mssqlHandler.runFuncAsTransaction.

* **req**: The `req` object used for logging.

* **...context**: Optional. Any number of options you want to pass along to `func`.

### mssqlHandler.escId(id)

Take the name of an identifier (for e.g. a table, column or index) and return it escaped, ready to be used in an SQL statement.
It might be a good convention to use a `q_` prefix for variables holding quoted identifiers.
Example:

```js
const tableName = "Table123";
const q_tableName = mssqlHandler.escId(tableName);
await mssqlHandler.runDbQuery({
  config,
  req,
  query: `UPDATE ${q_tableName} SET a = 0;`,
});
```

(There is no function for escaping values. Use the `params` option for that.)

### mssqlHandler.unEscId(q_id)

The inverse of `mssqlHandler.escId`.

### mssqlHandler.mssql

The `mssql` module, in case you need to by-pass the wrapper.

## Development

Run `./script` without arguments for help.
