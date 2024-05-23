import { describe, expect, test, spyOn } from "bun:test";
import { filterLiteServers } from "../src/index.ts";
import * as Filter from "../src/filter.ts";

type MockedLiteServer = Filter.LsConfig & {
  _result: Filter.ServerBenchmark;
};

spyOn(Filter, "benchmark").mockImplementation(
  // @ts-expect-error - we will have _result in the mocked object.
  async (ls: MockedLiteServer) => {
    return ls._result;
  }
);

const mockServer = (
  server: Partial<MockedLiteServer>,
  result: Partial<Filter.ServerBenchmark>
) => {
  return {
    _result: {
      successCount: 1,
      avgTiming: 100,
      errorCount: 0,
      fulfilled: true,
      seqnos: [1],
      timings: [1],
      readyIn: 1,
      ...result,
    },
    id: { key: "key" },
    ip: 123,
    port: 80,
    ...server,
  };
};

describe("filter", () => {
  test("fast and good should be error if successCount is 0", async () => {
    const servers: MockedLiteServer[] = [mockServer({}, { successCount: 0 })];

    spyOn(Filter, "getServers").mockReturnValue(Promise.resolve(servers));

    const res = await filterLiteServers("mainnet");

    expect(res.fast.length).toEqual(0);
    expect(res.good.length).toEqual(0);
    expect(res.fulfilled.length).toEqual(servers.length);
  });

  test.only("fast and good should be 1 when some server has successCount greater than 0", async () => {
    const servers: MockedLiteServer[] = [
      mockServer({}, { successCount: 1 }),
      mockServer({}, { successCount: 0 }),
    ];

    spyOn(Filter, "getServers").mockReturnValue(Promise.resolve(servers));

    const res = await filterLiteServers("mainnet");

    expect(res.good.length).toEqual(1);
    expect(res.fast.length).toEqual(1);
    expect(res.fulfilled.length).toEqual(servers.length);
  });
});
