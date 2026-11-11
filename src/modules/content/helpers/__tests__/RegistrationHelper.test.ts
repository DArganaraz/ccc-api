const sendTransactional = jest.fn();
jest.mock("../../../../shared/helpers/TransactionalEmailHelper", () => ({ TransactionalEmailHelper: { fromAddress: (name: string) => name + " <s@test>", sendTransactional: (...args: any[]) => sendTransactional(...args) } }));
jest.mock("../../../../shared/helpers/Environment", () => ({ Environment: { b1AdminRoot: "https://admin.test", b1AppRoot: "https://{subdomain}.site.test/", supportEmail: "s@test" } }));

import { RegistrationHelper } from "../RegistrationHelper.js";
import { Environment } from "../../../../shared/helpers/Environment.js";

const event = { title: "Christmas", start: new Date("2026-12-13T02:00:00Z"), allDay: false } as any;

describe("RegistrationHelper.sendConfirmationEmail", () => {
  beforeEach(() => sendTransactional.mockClear());

  it("links the church's member website and uses Australian dates", async () => {
    await RegistrationHelper.sendConfirmationEmail("a@test", "Church", event, { status: "confirmed" } as any, [], "Australia/Melbourne", "north");
    const [, , , appUrl, , contents] = sendTransactional.mock.calls[0];
    expect(appUrl).toBe("https://north.site.test");
    expect(contents).toContain('<a href="https://north.site.test">north.site.test</a>');
    expect(contents).toContain("Sunday 13 December 2026");
  });

  it("works with a fixed address and falls back to the admin site without a subdomain", async () => {
    (Environment as any).b1AppRoot = "https://my.church.test";
    expect(RegistrationHelper.memberSiteUrl("north")).toBe("https://my.church.test");
    await RegistrationHelper.sendConfirmationEmail("a@test", "Church", event, { status: "confirmed" } as any, []);
    const [, , , appUrl, , contents] = sendTransactional.mock.calls[0];
    expect(appUrl).toBe("https://admin.test");
    expect(contents).not.toContain("coming up");
  });
});
