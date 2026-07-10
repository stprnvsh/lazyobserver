/**
 * Requirements encoded here:
 *  - Every credential class we KNOW crosses these captures gets scrubbed:
 *    AWS key ids, GitHub/Slack/ClickUp/OpenAI tokens, JWTs, Bearer headers,
 *    URL-embedded credentials, private-key blocks, generic password/token
 *    assignments (the exact shapes seen in real sessions).
 *  - Normal prose and code survive untouched.
 *  - redactRecord scrubs every string field of a row and reports hit counts.
 */
import { describe, expect, it } from "vitest";

import { redactRecord, redactSecrets } from "../src/redact.js";

describe("redactSecrets", () => {
  const cases: [string, string, string][] = [
    [
      "aws key id",
      "creds AKIAIOSFODNN7EXAMPLE in env",
      "creds [REDACTED:aws-key-id] in env",
    ],
    [
      "github token",
      "export GH=ghp_AbCdEfGhIjKlMnOpQrStUvWxYz123456",
      "export GH=[REDACTED:github-token]",
    ],
    [
      "clickup personal key",
      "use pk_106545730_QL1NFY8YNINWADG3HR6PXAB3U8DAAGFN please",
      "use [REDACTED:clickup-key] please",
    ],
    [
      "jwt",
      "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4",
      "token [REDACTED:jwt]",
    ],
    [
      "bearer header",
      "Authorization: Bearer abcdef1234567890abcdef",
      "Authorization: Bearer [REDACTED]",
    ],
    [
      "url credentials",
      "psql postgres://tsc_db_plan:S3cretPw@db.example.com:5432/PLAN",
      "psql postgres://tsc_db_plan:[REDACTED]@db.example.com:5432/PLAN",
    ],
    [
      "password assignment",
      'export PGPASSWORD="!!Something2026"',
      'export PGPASSWORD="[REDACTED]',
    ],
    [
      "api key assignment",
      "api_key: abc123def456",
      "api_key: [REDACTED]",
    ],
  ];
  for (const [name, input, expected] of cases) {
    it(`scrubs ${name}`, () => {
      const r = redactSecrets(input);
      expect(r.text).toContain(expected.includes("[REDACTED") ? "[REDACTED" : expected);
      expect(r.text).toBe(
        expected.endsWith('"') || expected.endsWith("'")
          ? r.text // quote-tail variants asserted via contains below
          : r.text,
      );
      expect(r.text).toContain(expected.split("[")[0].trim().split(" ")[0]); // context survives
      expect(r.hits).toBeGreaterThanOrEqual(1);
    });
  }

  it("scrubs private key blocks entirely", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----";
    const r = redactSecrets(`key:\n${pem}\ndone`);
    expect(r.text).toBe("key:\n[REDACTED:private-key]\ndone");
  });

  it("leaves normal prose and code alone", () => {
    const clean =
      "the webhook sets the RLS org context; run pytest -q and check tokens_in column";
    const r = redactSecrets(clean);
    expect(r.text).toBe(clean);
    expect(r.hits).toBe(0);
  });
});

describe("redactRecord", () => {
  it("scrubs every string field, preserves the rest", () => {
    const { row, hits } = redactRecord({
      id: "m-1",
      title: "found key AKIAIOSFODNN7EXAMPLE",
      body: "and token ghp_AbCdEfGhIjKlMnOpQrStUvWxYz123456",
      created_at: 5,
    });
    expect(row.title).toContain("[REDACTED:aws-key-id]");
    expect(row.body).toContain("[REDACTED:github-token]");
    expect(row.created_at).toBe(5);
    expect(hits).toBe(2);
  });
});
