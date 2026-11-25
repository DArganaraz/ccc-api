jest.mock("../../../../shared/helpers/TransactionalEmailHelper", () => ({ TransactionalEmailHelper: { sendTransactional: jest.fn(), fromAddress: jest.fn(() => "from@test") } }));
jest.mock("../../../../shared/helpers/Environment", () => ({ Environment: { b1AdminRoot: "https://app.test", b1AppRoot: "https://{subdomain}.site.test/" } }));

import { RegistrationHelper } from "../RegistrationHelper.js";
import { TransactionalEmailHelper } from "../../../../shared/helpers/TransactionalEmailHelper.js";
import { Environment } from "../../../../shared/helpers/Environment.js";

const sendTransactional = TransactionalEmailHelper.sendTransactional as jest.Mock;
const lastBody = () => sendTransactional.mock.calls[sendTransactional.mock.calls.length - 1][5] as string;

describe("RegistrationHelper confirmation message", () => {
  beforeEach(() => sendTransactional.mockClear());

  it("adds the event's message as escaped plain text with its line breaks", async () => {
    const event = { title: "Camp", start: new Date("2026-12-01T15:00:00Z"), confirmationMessage: "Bring <b>boots</b> & \"snacks\"\nMeet at the north lot" };
    await RegistrationHelper.sendConfirmationEmail("a@test", "Grace", event, { status: "confirmed" }, []);
    const body = lastBody();
    expect(body).toContain("Bring &lt;b&gt;boots&lt;/b&gt; &amp; &quot;snacks&quot;<br>Meet at the north lot");
    expect(body).not.toContain("<b>boots</b>");
  });

  it("leaves the message out when the event has none", async () => {
    await RegistrationHelper.sendConfirmationEmail("a@test", "Grace", { title: "Camp", confirmationMessage: "  " }, { status: "confirmed" }, []);
    expect(lastBody()).not.toMatch(/<p>\s*<\/p>/);
  });

  it("holds the message back from a waitlisted registrant", async () => {
    await RegistrationHelper.sendConfirmationEmail("a@test", "Grace", { title: "Camp", confirmationMessage: "Zoom link: https://example.com/j/1" }, { status: "waitlisted" }, []);
    expect(lastBody()).not.toContain("Zoom link");
  });
});

describe("RegistrationHelper balance reminder", () => {
  beforeEach(() => sendTransactional.mockClear());

  it("lists the total, paid and balance and links to My Registrations", async () => {
    await RegistrationHelper.sendBalanceReminderEmail("a@test", "Grace", { title: "Camp <2026>" }, { total: "$45.00", paid: "$20.00", balance: "$25.00" }, "https://grace.b1.church/mobile/registrations");
    const [, to, , , subject, body] = sendTransactional.mock.calls[0];
    expect(to).toBe("a@test");
    expect(subject).toBe("Balance Due: Camp <2026>");
    expect(body).toContain("Camp &lt;2026&gt;");
    expect(body).toContain("$45.00");
    expect(body).toContain("$20.00");
    expect(body).toContain("$25.00");
    expect(body).toContain('href="https://grace.b1.church/mobile/registrations"');
  });

  it("asks the registrant to contact the church when there is no pay link", async () => {
    await RegistrationHelper.sendBalanceReminderEmail("a@test", "Grace", { title: "Camp" }, { total: "$45.00", paid: "$0.00", balance: "$45.00" });
    expect(lastBody()).toContain("contact the church office");
  });

  it("sends nothing without an email", async () => {
    await RegistrationHelper.sendBalanceReminderEmail("", "Grace", { title: "Camp" }, { total: "$1.00", paid: "$0.00", balance: "$1.00" });
    expect(sendTransactional).not.toHaveBeenCalled();
  });
});

// MyConnect: each campus's confirmation links its own member site, with Australian dates.
describe("RegistrationHelper member site link", () => {
  const event = { title: "Christmas", start: new Date("2026-12-13T02:00:00Z"), allDay: false };
  beforeEach(() => sendTransactional.mockClear());

  it("links the church's member website and uses Australian dates", async () => {
    await RegistrationHelper.sendConfirmationEmail("a@test", "Church", event, { status: "confirmed" }, [], "Australia/Melbourne", "north");
    const [, , , appUrl, , contents] = sendTransactional.mock.calls[0];
    expect(appUrl).toBe("https://north.site.test");
    expect(contents).toContain('<a href="https://north.site.test">north.site.test</a>');
    expect(contents).toContain("Sunday 13 December 2026");
  });

  it("works with a fixed address and falls back to the admin site without a subdomain", async () => {
    (Environment as { b1AppRoot: string }).b1AppRoot = "https://my.church.test";
    expect(RegistrationHelper.memberSiteUrl("north")).toBe("https://my.church.test");
    await RegistrationHelper.sendConfirmationEmail("a@test", "Church", event, { status: "confirmed" }, []);
    const [, , , appUrl, , contents] = sendTransactional.mock.calls[0];
    expect(appUrl).toBe("https://app.test");
    expect(contents).not.toContain("coming up");
  });
});
