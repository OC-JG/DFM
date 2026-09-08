# The two webfonts, and why they are here as bytes

`src/index.html` used to carry a `<link>` to `fonts.googleapis.com` for these
two families, which meant the tool rendered in Archivo and JetBrains Mono when
it had a connection and in whatever the machine had otherwise — silently, with
no indication that the typography on screen was not the typography that was
designed. `test/offline.mjs` had a standing exception for it: the `--vendor`
build, whose entire purpose is needing no network, still reached out for these.

So they are vendored. 75 kB of woff2, about 100 kB once base64'd into the
artifact, on a file that is already 825 kB — and in exchange the tool looks the
same on a shop-floor PC with the internet blocked as it does on a desk with
fibre, and the offline build's promise is kept rather than nearly kept.

## What these files are

Both are the **latin subset** as served by Google Fonts, and both are
**variable** fonts: one file per family covers every weight the stylesheet asks
for (Archivo 400/500/700/900, JetBrains Mono 300/400/500/700). That is why
there are two files rather than eight.

| File | Family | Subset | Bytes |
|---|---|---|---|
| `archivo-latin.woff2` | Archivo | latin (U+0000–00FF …) | 34,928 |
| `jetbrains-mono-latin.woff2` | JetBrains Mono | latin (U+0000–00FF …) | 40,404 |

Latin only, deliberately: the interface is English, the numbers are the point,
and latin-ext, Cyrillic, Greek and Vietnamese would triple the size for
glyphs nothing in this tool renders. The CSS keeps a real fallback stack, so a
character outside the subset still draws — in the system font, which is the
right failure.

## Licences

Both are SIL Open Font License 1.1, whose terms require the copyright notice
and the licence to travel with any copy of the font software. Since the
artifact *contains* the fonts, `build.js` puts both copyright notices and the
licence text into the banner at the top of `dfm-tool.html`, next to the MIT
notice for the tool's own code. `OFL-Archivo.txt` and `OFL-JetBrainsMono.txt`
are the two upstream files verbatim; the licence body below the header is
identical in both, so the artifact carries it once with both notices above it.

Neither font declares a Reserved Font Name, so a subset keeping the family name
is within the licence.

## Refreshing them

Ask Google Fonts for the CSS, read the `latin` block's URL out of it, and
fetch that:

```sh
curl -A 'Mozilla/5.0 Chrome/120' \
  'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;700&family=Archivo:wght@400;500;700;900&display=swap'
```

The `/* latin */` comment above each `@font-face` is what identifies the block;
there is one `latin` URL per family and it is the file to save here. Take the
licence from the family's upstream repository at the same time — the version
in the font and the version in this directory should be the same one.
