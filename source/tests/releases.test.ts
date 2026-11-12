import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { fetchRelease, parseRelease } from "../src/releases";
import { newTrace } from "../src/trace";
test("release checks distinguish rate limits from permission failures", async () => {
  await assert.rejects(
    fetchRelease("shusfun/Qingyi", "3.1.0", newTrace(), {
      fetch: async () =>
        new Response("", {
          status: 403,
          headers: { "x-ratelimit-remaining": "0" },
        }),
      record: () => {},
    }),
    /RELEASE_RATE_LIMITED/,
  );
});
const zip = Buffer.from("PK\x03\x04Qingyi isolated release fixture"),
  digest = createHash("sha256").update(zip).digest("hex"),
  filename = "qingyi-3.0.0-chromium.zip";
const release = {
  tag_name: "v3.0.0",
  body: "Release description",
  html_url: "https://github.com/qingyi/acceptance/releases/tag/v3.0.0",
  assets: [
    {
      name: filename,
      browser_download_url:
        "https://github.com/qingyi/acceptance/releases/download/v3.0.0/" +
        filename,
      size: zip.length,
      digest: "sha256:" + digest,
    },
    {
      name: filename + ".sha256",
      browser_download_url:
        "https://github.com/qingyi/acceptance/releases/download/v3.0.0/" +
        filename +
        ".sha256",
      size: 128,
    },
  ],
};
test("release matching checks version, Chromium package, repository origin and checksum", () => {
  const r = parseRelease(release, "Qingyi/acceptance", "2.1.0");
  assert.equal(r.newer, true);
  assert.equal(r.assets.length, 2);
  assert.equal(r.hasChecksum, true);
  assert.equal(r.assets[0].digest, "sha256:" + digest);
  assert.equal(
    parseRelease(release, "qingyi/acceptance", "3.0.0").newer,
    false,
  );
  assert.equal(
    parseRelease(
      {
        ...release,
        assets: [{ ...release.assets[0], name: "qingyi-3.0.0-firefox.zip" }],
      },
      "qingyi/acceptance",
      "2.0.0",
    ).assets.length,
    0,
  );
  assert.throws(
    () =>
      parseRelease(
        {
          ...release,
          assets: [
            {
              ...release.assets[0],
              browser_download_url:
                "https://github.com/other/repo/releases/download/v3.0.0/" +
                filename,
            },
          ],
        },
        "qingyi/acceptance",
        "2.0.0",
      ),
    /INVALID_RELEASE_ASSET_URL/,
  );
  assert.throws(
    () =>
      parseRelease(
        { ...release, assets: [release.assets[0], release.assets[0]] },
        "qingyi/acceptance",
        "2.0.0",
      ),
    /DUPLICATE_RELEASE_ASSET/,
  );
  assert.throws(
    () =>
      parseRelease(
        { ...release, tag_name: "v999999999999999999999.0.0" },
        "qingyi/acceptance",
        "2.0.0",
      ),
    /INVALID_RELEASE_VERSION/,
  );
});
test("release HTTP success, refusal, malformed metadata and downloads preserve trace and bytes", async () => {
  const requests: any[] = [],
    events: any[] = [],
    t = newTrace();
  const server = createServer((req, res) => {
    const path = req.url || "";
    requests.push({
      path,
      traceparent: req.headers.traceparent,
      requestId: req.headers["x-request-id"],
      authorization: req.headers.authorization,
    });
    res.setHeader("x-github-request-id", "fixture-provider-id");
    if (path.includes("/denied/")) {
      res.writeHead(403).end("{}");
      return;
    }
    if (path.includes("/invalid/")) {
      res.writeHead(200, { "Content-Type": "application/json" }).end("{broken");
      return;
    }
    if (path.includes("/oversized/")) {
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(" ".repeat(2 * 1024 * 1024 + 1));
      return;
    }
    if (path.endsWith(".zip")) {
      res.writeHead(200, { "Content-Type": "application/zip" }).end(zip);
      return;
    }
    if (path.endsWith(".sha256")) {
      res.end(digest + "  " + filename + "\n");
      return;
    }
    res
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify(release));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;
  const redirectedFetch: typeof fetch = (url, options) =>
    fetch("http://127.0.0.1:" + port + new URL(String(url)).pathname, options);
  const record = (trace: any, event: string, fields: any) =>
    events.push({ trace, event, ...fields });
  try {
    const r = await fetchRelease("qingyi/acceptance", "2.1.0", t, {
      fetch: redirectedFetch,
      record,
    });
    assert.equal(r.assets.length, 2);
    assert.match(
      requests[0].traceparent,
      new RegExp("^00-" + t.traceId + "-[a-f0-9]{16}-01$"),
    );
    assert.ok(requests[0].requestId);
    assert.equal(requests[0].authorization, undefined);
    const success = events.find((e) => e.event === "release.http.end");
    assert.equal(success.status, 200);
    assert.equal(success.providerRequestId, "fixture-provider-id");
    assert.equal(success.trace.traceId, t.traceId);
    const received = Buffer.from(
        await (await redirectedFetch(r.assets[0].url)).arrayBuffer(),
      ),
      sum = await (await redirectedFetch(r.assets[1].url)).text();
    assert.equal(
      createHash("sha256").update(received).digest("hex"),
      sum.split(/\s/)[0],
    );
    assert.deepEqual(received, zip);
    await assert.rejects(
      fetchRelease("qingyi/denied", "3.0.0", newTrace(), {
        fetch: redirectedFetch,
        record,
      }),
      /RELEASE_HTTP_403/,
    );
    await assert.rejects(
      fetchRelease("qingyi/invalid", "3.0.0", newTrace(), {
        fetch: redirectedFetch,
        record,
      }),
    );
    await assert.rejects(
      fetchRelease("qingyi/oversized", "3.0.0", newTrace(), {
        fetch: redirectedFetch,
        record,
      }),
      /DECOMPRESS_LIMIT/,
    );
    assert.equal(
      events.filter(
        (e) => e.event === "release.http.end" && e.outcome === "failed",
      ).length,
      3,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
