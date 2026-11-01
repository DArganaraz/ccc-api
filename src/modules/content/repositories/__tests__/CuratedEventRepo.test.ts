import "reflect-metadata";
jest.mock("../../db/index", () => ({ getDb: jest.fn() }));
jest.mock("@churchapps/apihelper", () => ({ UniqueIdHelper: { shortId: () => "gen_id" } }));

import { getDb } from "../../db/index.js";
import { CuratedEventRepo } from "../CuratedEventRepo.js";

function recordingDb(rows: any[] = []) {
  const calls: { method: string; args: any[] }[] = [];
  const proxy: any = new Proxy(
    {},
    {
      get(_t, prop) {
        if (typeof prop === "symbol" || prop === "then") return undefined;
        if (prop === "execute") return async () => rows;
        return (...args: any[]) => {
          calls.push({ method: prop as string, args });
          return proxy;
        };
      }
    }
  );
  return { proxy, calls };
}

const filtersPublic = (calls: { method: string; args: any[] }[]) =>
  calls.some((c) => c.method === "where" && c.args[0] === "e.visibility" && c.args[2] === "public");

describe("CuratedEventRepo.loadForEvents (#1211)", () => {
  it("only returns public events by default (public calendar, ICS feed)", async () => {
    const { proxy, calls } = recordingDb();
    (getDb as jest.Mock).mockReturnValue(proxy);
    await new CuratedEventRepo().loadForEvents("CAL1", "c1");
    expect(filtersPublic(calls)).toBe(true);
  });

  it("includes private events when asked (admin curated calendar)", async () => {
    const { proxy, calls } = recordingDb();
    (getDb as jest.Mock).mockReturnValue(proxy);
    await new CuratedEventRepo().loadForEvents("CAL1", "c1", true);
    expect(filtersPublic(calls)).toBe(false);
  });
});

describe("CuratedEventRepo.loadForEvents duplicates", () => {
  it("returns an event once when it is on the calendar through its group and on its own", async () => {
    const rows = [
      { id: "ce_group", eventId: null, realEventId: "ev1", title: "Aged Care visit" },
      { id: "ce_other", eventId: null, realEventId: "ev2", title: "Another" },
      { id: "ce_own", eventId: "ev1", realEventId: "ev1", title: "Aged Care visit" }
    ];
    (getDb as jest.Mock).mockReturnValue(recordingDb(rows).proxy);
    const result = await new CuratedEventRepo().loadForEvents("CAL1", "c1", true);
    expect(result.map((r: any) => r.realEventId)).toEqual(["ev1", "ev2"]);
    expect(result[0].id).toBe("ce_own");
  });
});
