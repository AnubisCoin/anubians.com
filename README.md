# anubians.com

Static website for the Anubians collection. The whole site lives in `wwwroot/`
and is published to `gh-pages` by `.github/workflows/githubpages.yml`.

## Archive

`wwwroot/archive/` is a fully static, backend-free browser for all 10,000
Anubians. It is driven by two generated artifacts:

- `wwwroot/archive/data.json` – one record per Anubian
  (`n`, `name`, `symbol`, `uid`, `token`, `a`: list of `[type, value, rarity]`).
- `wwwroot/archive/img/<n>.png` – the NFT image, 590×590 PNG.

Both are produced by `tools/scrape-anubians.mjs`, which resolves every Anubian
through the Nileswap / Hathor explorers. The run is resumable: progress is
cached in `tools/.cache/records.jsonl`, so interrupted runs pick up where they
left off.

```bash
# full scrape (skips everything already cached)
node tools/scrape-anubians.mjs --from 1 --to 10000 --concurrency 10

# rebuild data.json from the cache without touching the network
node tools/scrape-anubians.mjs --build-only
```

Three Anubians (#2823, #3181, #3761) carry no `nft_media` in their on-chain
metadata. Their artwork is still pinned to IPFS and linked from the Nileswap
token page, so the scraper falls back to IPFS gateways and stores those images
as well. If an image can never be recovered, the archive falls back to a
"No image" frame and a "Minted without media" label in the detail view.
