import { createLiveStore, LIVE_SCOPE } from "./live-store.js";

/** One raw Loredex search, printed verbatim — for diagnosing result shape. */
async function main(): Promise<void> {
  const { open } = await createLiveStore();
  const conn = await open();
  try {
    const res = await conn.call("search", {
      query: "caffeine",
      folderId: LIVE_SCOPE.root,
      limit: 5,
      mode: "text",
    });
    console.log(`ok=${res.ok}`);
    console.log(res.text.slice(0, 3000));
  } finally {
    await conn.close();
  }
}

await main();
