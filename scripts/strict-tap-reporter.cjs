"use strict";

const { tap } = require("node:test/reporters");

module.exports = async function* strictTapReporter(source) {
  const deferred = [];
  async function* observed() {
    for await (const event of source) {
      if (event.data && (event.data.skip !== undefined || event.data.todo !== undefined)) {
        deferred.push({ name: event.data.name, skip: event.data.skip, todo: event.data.todo });
      }
      yield event;
    }
  }
  yield* tap(observed());
  if (deferred.length) {
    const names = deferred.map(({ name, skip, todo }) => `${name} (${skip !== undefined ? "skip" : "todo"}${typeof (skip ?? todo) === "string" ? `: ${skip ?? todo}` : ""})`);
    throw new Error(`deferred tests are not allowed: ${names.join(", ")}`);
  }
};
