import { describe, expect, it } from "vitest";
import { deferredResults } from "./deferred-results";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => resolve = done);
  return { promise, resolve };
}

describe("deferred results", () => {
  it("lets a slow read land while successive refreshes are still pending", async () => {
    const adopt = deferredResults<number>();
    const first = deferred<number>();
    const second = deferred<number>();
    const third = deferred<number>();
    const values: number[] = [];
    const save = (value: number) => values.push(value);
    const one = adopt(first.promise, save);
    const two = adopt(second.promise, save);
    const three = adopt(third.promise, save);
    first.resolve(1);
    await one;
    expect(values).toEqual([1]);
    second.resolve(2);
    await two;
    expect(values).toEqual([1, 2]);
    third.resolve(3);
    await three;
    expect(values).toEqual([1, 2, 3]);
  });

  it("does not let an older response overwrite a newer completed read", async () => {
    const adopt = deferredResults<number>();
    const first = deferred<number>();
    const second = deferred<number>();
    const values: number[] = [];
    const one = adopt(first.promise, (value) => values.push(value));
    const two = adopt(second.promise, (value) => values.push(value));
    second.resolve(2);
    await two;
    first.resolve(1);
    await one;
    expect(values).toEqual([2]);
  });

  it("allows the caller to reject results belonging to a previous run", async () => {
    const adopt = deferredResults<number>();
    let runId = "a";
    let bill: number | null = null;
    const first = deferred<number>();
    const id = runId;
    const one = adopt(first.promise, (value) => {
      if (runId === id) bill = value;
    });
    runId = "b";
    first.resolve(1);
    await one;
    expect(bill).toBeNull();
    await adopt(Promise.resolve(2), (value) => bill = value);
    expect(bill).toBe(2);
  });
});
