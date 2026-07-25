# Docs

User-facing documentation is the VitePress site under `docs/content/` (`en`, `zh-Hans`, `ja`).

```sh
pnpm dev:docs     # from repo root
pnpm -F @proj-vera/docs run build
```

Published upstream site: [https://airi.moeru.ai/docs/](https://airi.moeru.ai/docs/) (Moeru Project AIRI). Local: `pnpm dev:docs`.

| Path | Role |
|------|------|
| [`README.zh-CN.md`](./README.zh-CN.md) | Chinese repository overview |
| [`handbook/`](./handbook/) | Engineering contracts (source of truth for ownership boundaries) |
| [`records/`](./records/) | Dated plans / archive (not live contracts) |
| [`content/`](./content/) | VitePress pages (manual, blog, contributing) |
| [`reference/`](./reference/) | Vendor / API reference notes |

Root product README: [`../README.md`](../README.md).
