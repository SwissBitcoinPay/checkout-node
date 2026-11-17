import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  InvalidInvoiceError,
  InvalidOrderError,
  NetworkError,
  Sattleme,
  type Invoice,
  type PaymentStatus
} from "../src/index.js";

import { answer } from "./helpers/fetch.js";
import { TestMerchant } from "./helpers/merchant.js";

let merchant: TestMerchant;
let sattleme: Sattleme;
let invoice: Invoice;

beforeEach(async () => {
  merchant = await new TestMerchant().start();
  merchant.publishChannel(merchant.channelValue(100), 100);
  sattleme = new Sattleme({
    key: merchant.key,
    fetch: merchant.http.fetch,
    WebSocket: merchant.net.WebSocket,
    now: () => merchant.now * 1000,
    logger: { warn: () => {} }
  });
  invoice = await sattleme.createInvoice({ ref: "P-1", sats: 2100, durationSeconds: 600 });
});

afterEach(async () => {
  await merchant.stop();
});

/** breez.tips's verify answer for the invoice, replaced. */
function verifyAnswers(json: unknown, status = 200) {
  merchant.override = (url) =>
    url.pathname.includes("/verify/") ? answer(json, status) : undefined;
}

describe("getStatus", () => {
  it("is open, then paid with the preimage, the proof of payment", async () => {
    expect(await sattleme.getStatus(invoice)).toEqual({
      state: "open",
      expiresAt: invoice.expiresAt,
      received: "0",
      rest: null
    });
    merchant.payInvoice(invoice.paymentHash!);
    expect(await sattleme.getStatus(invoice)).toEqual({
      state: "paid",
      method: "lightning",
      preimage: merchant.invoices.get(invoice.paymentHash!)!.preimage
    });
    // A look, without state: from the stored invoice, as JSON.
    expect(await sattleme.getStatus(JSON.parse(JSON.stringify(invoice)) as Invoice)).toMatchObject({
      state: "paid"
    });
  });

  it("reads the invoice whatever its case, and an upper-case preimage", async () => {
    const made = merchant.invoices.get(invoice.paymentHash!)!;
    verifyAnswers({
      status: "OK",
      settled: true,
      preimage: made.preimage.toUpperCase(),
      pr: made.pr.toUpperCase()
    });
    expect(await sattleme.getStatus(invoice)).toEqual({
      state: "paid",
      method: "lightning",
      preimage: made.preimage
    });
  });

  it("refuses an answer about another invoice, and a wrong preimage", async () => {
    const made = merchant.invoices.get(invoice.paymentHash!)!;
    const other = await sattleme.createInvoice({ ref: "P-2", sats: 2100, durationSeconds: 600 });
    verifyAnswers({ status: "OK", settled: true, preimage: made.preimage, pr: other.bolt11 });
    await expect(sattleme.getStatus(invoice)).rejects.toBeInstanceOf(InvalidInvoiceError);
    verifyAnswers({ status: "OK", settled: true, preimage: "11".repeat(32), pr: made.pr });
    await expect(sattleme.getStatus(invoice)).rejects.toBeInstanceOf(InvalidInvoiceError);
    verifyAnswers({ status: "OK", settled: true, preimage: null, pr: made.pr });
    await expect(sattleme.getStatus(invoice)).rejects.toBeInstanceOf(InvalidInvoiceError);
    verifyAnswers({ status: "OK", settled: true, preimage: made.preimage });
    await expect(sattleme.getStatus(invoice)).rejects.toBeInstanceOf(InvalidInvoiceError);
  });

  it("is expired 120 s after the invoice's end, not before", async () => {
    merchant.now = invoice.expiresAt + 119;
    expect(await sattleme.getStatus(invoice)).toMatchObject({ state: "open" });
    merchant.now = invoice.expiresAt + 120;
    expect(await sattleme.getStatus(invoice)).toEqual({ state: "expired", received: "0" });
  });

  it('is expired on "Not found" after the grace only', async () => {
    verifyAnswers({ status: "ERROR", reason: "Not found" });
    merchant.now = invoice.expiresAt + 119;
    expect(await sattleme.getStatus(invoice)).toMatchObject({ state: "open" });
    merchant.now = invoice.expiresAt + 120;
    expect(await sattleme.getStatus(invoice)).toEqual({ state: "expired", received: "0" });
    verifyAnswers({ status: "ERROR", reason: "Not found" }, 404);
    expect(await sattleme.getStatus(invoice)).toEqual({ state: "expired", received: "0" });
  });

  it("keeps the invoice open on any other error before the grace, retries after", async () => {
    verifyAnswers({ status: "ERROR", reason: "Internal server error" });
    expect(await sattleme.getStatus(invoice)).toMatchObject({ state: "open" });
    merchant.now = invoice.expiresAt + 600;
    await expect(sattleme.getStatus(invoice)).rejects.toBeInstanceOf(NetworkError);
  });

  it("throws NetworkError, retryable, when breez.tips does not answer", async () => {
    for (const status of [500, 502, 429]) {
      verifyAnswers({ status: "ERROR", reason: "Not found" }, status);
      const error = await sattleme.getStatus(invoice).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NetworkError);
      expect((error as NetworkError).retryable).toBe(true);
    }
    merchant.override = (url) => {
      if (url.pathname.includes("/verify/")) throw new TypeError("fetch failed");
      return undefined;
    };
    await expect(sattleme.getStatus(invoice)).rejects.toBeInstanceOf(NetworkError);
    merchant.override = (url) =>
      url.pathname.includes("/verify/") ? { status: 200, text: "<html>" } : undefined;
    await expect(sattleme.getStatus(invoice)).rejects.toBeInstanceOf(NetworkError);
  });

  it("refuses a stored invoice that is not what createInvoice gave", async () => {
    for (const changed of [
      { ...invoice, paymentHash: "00".repeat(32) },
      { ...invoice, expiresAt: invoice.expiresAt + 3600 },
      { ...invoice, verifyUrl: "http://breez.tips/x" },
      { ...invoice, bolt11: "lnbc1" }
    ]) {
      await expect(sattleme.getStatus(changed)).rejects.toBeInstanceOf(InvalidOrderError);
    }
  });
});

describe("waitForPayment", () => {
  it("checks until the invoice is paid, network errors retried", async () => {
    const seen: PaymentStatus["state"][] = [];
    let calls = 0;
    merchant.override = (url) => {
      if (!url.pathname.includes("/verify/")) return undefined;
      calls += 1;
      if (calls === 2) throw new TypeError("fetch failed");
      if (calls === 3) merchant.payInvoice(invoice.paymentHash!);
      return undefined;
    };
    const final = await sattleme.waitForPayment(invoice, {
      intervalMs: 250,
      onStatus: (status) => seen.push(status.state)
    });
    expect(final).toMatchObject({ state: "paid" });
    expect(seen).toEqual(["open", "paid"]);
  });

  it("logs a failure each check meets again once, and again only after it stopped", async () => {
    const warnings: string[] = [];
    const logged = new Sattleme({
      key: merchant.key,
      fetch: merchant.http.fetch,
      WebSocket: merchant.net.WebSocket,
      now: () => merchant.now * 1000,
      logger: { warn: (message) => warnings.push(message) }
    });
    // Down for 3 checks, up for 1, down for 2 again, then paid.
    const down = [true, true, true, false, true, true];
    let calls = 0;
    merchant.override = (url) => {
      if (!url.pathname.includes("/verify/")) return undefined;
      calls += 1;
      if (calls > down.length) merchant.payInvoice(invoice.paymentHash!);
      return down[calls - 1] ? { status: 503, text: "down" } : undefined;
    };
    expect(await logged.waitForPayment(invoice, { intervalMs: 250 })).toMatchObject({
      state: "paid"
    });
    expect(calls).toBe(down.length + 1);
    expect(warnings).toEqual([
      "@sattleme/checkout: the payment check failed (breez.tips answered HTTP 503 without an LNURL answer); checked again",
      "@sattleme/checkout: the payment check failed (breez.tips answered HTTP 503 without an LNURL answer); checked again"
    ]);
  });

  it("stops at expired", async () => {
    merchant.now = invoice.expiresAt + 120;
    expect(await sattleme.waitForPayment(invoice, { intervalMs: 250 })).toEqual({
      state: "expired",
      received: "0"
    });
  });

  it("stops when its signal aborts", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("order cancelled")), 300);
    await expect(
      sattleme.waitForPayment(invoice, { intervalMs: 250, signal: controller.signal })
    ).rejects.toThrow("order cancelled");
  });

  it("stops on an answer that is not about this invoice", async () => {
    verifyAnswers({ status: "OK", settled: false, pr: "lnbc1other" });
    await expect(sattleme.waitForPayment(invoice, { intervalMs: 250 })).rejects.toBeInstanceOf(
      InvalidInvoiceError
    );
  });
});
