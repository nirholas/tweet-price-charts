# tweet-price-charts

Correlates **$THREE** token price action with three.ws's X (Twitter) posts, and renders
an interactive TradingView-style chart with every post plotted as an avatar bubble on the
candles — inspired by [rohunvora/tweet-price-charts](https://github.com/rohunvora/tweet-price-charts).

## What's here

```
index.html          # ← the published chart (GitHub Pages root). copy of out/chart.html
generate.mjs        # the analyzer + chart generator (Node, zero deps)
data/               # scraped tweets (trythreews + nichxbt), input
assets/             # real X avatars, embedded into the chart as base64
out/
  chart.html        # self-contained interactive chart (source of index.html)
  chart.json        # correlation stats (original posts only)
  chart.csv         # per-post detail: 1h/4h/24h returns
  *-with-replies.*  # same, but including replies/retweets
```

**Live:** https://overstepping.github.io/tweet-price-charts/ (served from root `index.html`).

## The chart (`out/chart.html`)

Self-contained — just open it in a browser (loads TradingView lightweight-charts from CDN;
all data + avatars are baked in).

- $THREE/SOL candles with **15m / 1h / 1d** toggle
- Every post as an **avatar bubble** on the candle it landed on
  (cyan border = @trythreews, magenta = @nichxbt, ▲ = announcement)
- Nearby posts **cluster** with a count badge so they don't overlap; clusters split as you zoom
- **Hover** a bubble → tweet text, views, and the actual +1h / +4h / +24h price return
- **Click** → opens the original tweet
- Right sidebar lists every post by 24h return; click to jump the chart there

## How returns are measured

For each post at time *T*, the entry price is the $THREE hourly candle **close at-or-just-before
*T***. Then `+Nh = (close N hours after T − entry) / entry × 100`. Price history is hourly
(and 15-minute for the chart) OHLCV from GeckoTerminal for the $THREE/SOL pump.swap pool.

## Key findings (original posts only, Apr 29 – Jun 15 2026, n=405)

Using **median** returns (a memecoin's mean is dominated by fat-tail outliers):

| Window | Post median | Random-hour baseline | Edge | Win rate |
|--------|------------|----------------------|------|----------|
| +1h  | −1.25% | −0.59% | −0.66pp | 46% |
| +4h  | −1.30% | −1.61% | +0.32pp | 45% |
| +24h | **+8.18%** | +1.87% | **+6.31pp** | **59%** |

- **No instant pump** — the median post is flat-to-down at 1h; the large *mean* is a few outliers.
- **Real 24h signal** — posts precede +8% vs +1.9% baseline, up 59% of the time.
- **Announcements drive it** — announcement posts: +35% avg / 24h vs +19% for routine posts.
- **Reach > frequency** — views↔24h return r≈0.15; posts-per-day↔daily return r≈0.04 (none).

Caveats: overlapping 24h windows inflate significance; reverse causality (we post more around
events) can't be ruled out; single token in an uptrend regime. Suggestive, not causal.

## Regenerate

```bash
node generate.mjs --accounts trythreews,nichxbt --chart \
  data/trythreews_tweets_2026-06-15.json \
  "data/nichxbt_tweets_2026-06-15.json" \
  "data/nichxbt_tweets_2026-06-15 (1).json" \
  "data/nichxbt_tweets_2026-06-15 (2).json" \
  "data/i_tweets_2026-06-15.json" \
  "data/i_tweets_2026-06-15 (1).json" \
  --out out/chart
```

Flags: `--accounts a,b` restrict to owned handles · `--own` original posts only (drop replies/RTs)
· `--chart` also emit the HTML · `--out <base>` output path prefix.

Price data: GeckoTerminal (free, no key). No mocks, no synthetic data.
