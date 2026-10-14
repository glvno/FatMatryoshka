# Licensing

FatMatryoshka is GPL-3.0-only (`LICENSE`). It is derived from [Modular-1](https://github.com/WiggisModular/Modular-1) by [@morgulbrut](https://github.com/morgulbrut) / [WiggisModular](https://github.com/WiggisModular), also GPL-3.0-only. Original copyright and licence notices are retained.

## Copied from Felucca

Source: <https://github.com/hugelton/Felucca> at commit `a4d7ca2e5d52a4c35e2468401f00d883cadbda03`.
Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments. GPL-3.0-only.

Copied files, to be changed only as part of FatMatryoshka's own work:

- `firmware/hal/`, `firmware/loader/`, `firmware/crt0.S`, `firmware/app.ld`
- `tools/build.py`, `tools/fm1_install.py`, `tools/fm1pkg_make.py`, `tools/lz4blk.py`, `tools/get_toolchain.sh`
- `web/src/flasher/fm1ota.js`, `web/src/flasher/fm1pkg.js`

Every one of these keeps its original `SPDX-License-Identifier` and copyright header.

## JieLi SDK files (Apache-2.0)

Packages made by `tools/build.py` embed three files from the JieLi AC79 SDK (`uboot.boot`, `cfg_tool.bin`, `cfg/eq_cfg_hw.bin`), Apache-2.0. They are not in this repository as files, but the prebuilt package that the web app bundles (`web/public/firmware/modular-1.fwsc`, made by `tools/build.py` and `npm run firmware`, published on GitHub Pages) contains them, so the licence texts (`LICENSE-GPL-3.0.txt`, `LICENSE-Apache-2.0.txt`) are published next to it and linked from the Flash tab. Ship `LICENSES/Apache-2.0.txt` with every package. The other texts in `LICENSES/` belong to Felucca's own bundled material (fonts, DSP ports) and apply only to files not copied here; they are kept so any later copy stays correctly attributed.

The self-hosted Alegreya SC Bold heading font is by Juan Pablo del Peral / Huerta Tipográfica, distributed under the SIL Open Font License 1.1. Its licence is included at `web/public/fonts/OFL-AlegreyaSC.txt`; source: https://github.com/google/fonts/tree/main/ofl/alegreyasc.

The SVG wordmark and patch editor use Barlow Semi Condensed Bold and Barlow Medium by Jeremy Tribby, distributed under the SIL Open Font License 1.1. Their licences are included at `web/public/fonts/OFL-BarlowSemiCondensed.txt` and `web/public/fonts/OFL-Barlow.txt`; sources: https://github.com/google/fonts/tree/main/ofl/barlowsemicondensed and https://github.com/google/fonts/tree/main/ofl/barlow. `web/scripts/wordmark.py` generates equal-height small caps and replaces the K stem with a footless numeral 1.

The ten logo concept PNGs in `web/public/brand/candidates/` were generated with the built-in image generation tool using the current project logo as reference. Their prompts are recorded in `docs/logo-candidate-prompts.json`. They are review candidates; the app continues to use `web/public/brand/fatmatryoshka.png`.

The twelve further pictorial concepts in `web/public/brand/round-two/` were generated with the built-in image tool; their exact prompts are in `docs/logo-round-two-prompts.json`. The comparison uses Nick Dawson's [design-partner skill](https://github.com/nickpdawson/claude-studio-design-partner-skill/blob/main/SKILL.md). The twelve SVG wordmark studies use Barlow, Barlow Condensed, Barlow Semi Condensed, Space Grotesk, Rajdhani, Archivo Black, and one custom line drawing. The additional font sources and OFL licence texts are included in `web/public/brand/round-two/fonts/`.
