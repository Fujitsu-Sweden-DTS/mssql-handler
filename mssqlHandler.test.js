"use strict";
/* global expect, test */
const mssqlHandler = require("./mssqlHandler");

const escId_test_cases = [
  ["Abc", "[Abc]"],
  ["Bc d", "[Bc d]"],
  ["cD-e", "[cD-e]"],
  ["d_eF", "[d_eF]"],
  ["E\\fg", "[E\\fg]"],
  ['f"gH', '[f"gH]'],
  ["g]H i", "[g]]H i]"],
  ["h[i J", "[h[i J]"],
  ["i j   k", "[i j   k]"],
  ["jk'l", "[jk'l]"],
  ["klm", "[klm]"],
  ["lmn", "[lmn]"],
  ["mno", "[mno]"],
  ["nop", "[nop]"],
  ["opq", "[opq]"],
  ["pqr", "[pqr]"],
  ["qrs", "[qrs]"],
  ["rst", "[rst]"],
  ["stu", "[stu]"],
];

test("escId and unEscId", () => {
  for (const [unescaped, escaped] of escId_test_cases) {
    expect(mssqlHandler.escId(unescaped)).toEqual(escaped);
    expect(mssqlHandler.unEscId(escaped)).toEqual(unescaped);
  }
});
