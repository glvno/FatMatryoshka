# Licensing

Matryoshka is GPL-3.0-only (`LICENSE`). It is derived from [Modular-1](https://github.com/WiggisModular/Modular-1) by [@morgulbrut](https://github.com/morgulbrut) / [WiggisModular](https://github.com/WiggisModular), also GPL-3.0-only. Original copyright and licence notices are retained.

## Copied from Felucca

Source: <https://github.com/hugelton/Felucca> at commit `a4d7ca2e5d52a4c35e2468401f00d883cadbda03`.
Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments. GPL-3.0-only.

Copied files, to be changed only as part of Matryoshka's own work:

- `firmware/hal/`, `firmware/loader/`, `firmware/crt0.S`, `firmware/app.ld`
- `tools/build.py`, `tools/fm1_install.py`, `tools/fm1pkg_make.py`, `tools/lz4blk.py`, `tools/get_toolchain.sh`
- `web/src/flasher/fm1ota.js`, `web/src/flasher/fm1pkg.js`

Every one of these keeps its original `SPDX-License-Identifier` and copyright header.

## JieLi SDK files (Apache-2.0)

Packages made by `tools/build.py` embed three files from the JieLi AC79 SDK (`uboot.boot`, `cfg_tool.bin`, `cfg/eq_cfg_hw.bin`), Apache-2.0. They are not in this repository as files, but the prebuilt package that the web app bundles (`web/public/firmware/modular-1.fwsc`, made by `tools/build.py` and `npm run firmware`, published on GitHub Pages) contains them, so the licence texts (`LICENSE-GPL-3.0.txt`, `LICENSE-Apache-2.0.txt`) are published next to it and linked from the Flash tab. Ship `LICENSES/Apache-2.0.txt` with every package. The other texts in `LICENSES/` belong to Felucca's own bundled material (fonts, DSP ports) and apply only to files not copied here; they are kept so any later copy stays correctly attributed.

The self-hosted Alegreya SC Bold heading font is by Juan Pablo del Peral / Huerta Tipográfica, distributed under the SIL Open Font License 1.1. Its licence is included at `web/public/fonts/OFL-AlegreyaSC.txt`; source: https://github.com/google/fonts/tree/main/ofl/alegreyasc.

The patch editor and earlier wordmark use Barlow Semi Condensed Bold and Barlow Medium by Jeremy Tribby, distributed under the SIL Open Font License 1.1. Their licences are included at `web/public/fonts/OFL-BarlowSemiCondensed.txt` and `web/public/fonts/OFL-Barlow.txt`; sources: https://github.com/google/fonts/tree/main/ofl/barlowsemicondensed and https://github.com/google/fonts/tree/main/ofl/barlow. `web/scripts/wordmark.py` regenerates the legacy K-stem wordmark as a study without replacing the current branding.

The active SVG wordmark uses Roboto Flex under SIL OFL 1.1, with the selected axes and preset recorded in `web/public/brand/wordmark-settings.json`. `npm run brand:flex` generates its outlines from preset `p12` and promotes `round-three/29-hidden-arm-ends.png` to the app’s `brand/matryoshka.png`. The app displays the outlined SVG without loading a font renderer or the variable font at runtime.

The ten logo concept PNGs in `web/public/brand/candidates/` were generated with the built-in image generation tool using the current project logo as reference. Their prompts are recorded in `docs/logo-candidate-prompts.json`. They are review candidates; the app continues to use `web/public/brand/matryoshka.png`.

The twelve further pictorial concepts in `web/public/brand/round-two/` were generated with the built-in image tool; their exact prompts are in `docs/logo-round-two-prompts.json`. The comparison uses Nick Dawson's [design-partner skill](https://github.com/nickpdawson/claude-studio-design-partner-skill/blob/main/SKILL.md). The twelve SVG wordmark studies use Barlow, Barlow Condensed, Barlow Semi Condensed, Space Grotesk, Rajdhani, Archivo Black, and one custom line drawing. The additional font sources and OFL licence texts are included in `web/public/brand/round-two/fonts/`.

The third-round wordmarks use Roboto Flex from https://github.com/google/fonts/tree/main/ofl/robotoflex under the SIL Open Font License 1.1. The unmodified variable font and licence are included in `web/public/brand/round-three/fonts/`. `web/scripts/wordmark-flex.py` generates the SVG outlines and replaces the R stem in MATRYOSHKA with a custom footless numeral 1, so the accented letters read FM1. The two-sibling pictorial study was edited with the built-in image generator; its initial prompts are recorded in `web/public/brand/round-three/prompts.json` and its brand-color correction in `web/public/brand/round-three/brand-color-edit.json`.

The fourth-round type lab uses the same Roboto Flex font and existing brand artwork. `npm run brand:flex` in `web/` builds its SVG starting points and browser renderer. The browser bundle includes Fontkit (MIT, Devon Govett) and dependencies; their notices are included in `web/public/brand/round-four/third-party-notices.txt` and the generated bundle’s linked licence comments.

The lab’s revised doll artwork, `web/public/brand/round-three/25-routed-smile.png`, was edited with the built-in image generator. Its exact cable-routing and smile prompt is recorded in `web/public/brand/round-three/routing-smile-edit.json`.

The subsequent revision, `web/public/brand/round-three/26-port-aligned-faces.png`, gives the smallest dolls white faces with black eyes and aligns the outer shell’s internal cable origins with its external ports. It was edited with the built-in image generator; the exact prompt is in `web/public/brand/round-three/port-aligned-faces-edit.json`.

The all-coral cable variant, `web/public/brand/round-three/27-coral-cables.png`, was edited with the built-in image generator. Its prompt is in `web/public/brand/round-three/coral-cables-edit.json`.

The doll-colored cable-arm variant, `web/public/brand/round-three/28-doll-colored-arms.png`, was edited with the built-in image generator. Its prompt is in `web/public/brand/round-three/doll-colored-arms-edit.json`.

The hidden cable-end revision, `web/public/brand/round-three/29-hidden-arm-ends.png`, was edited with the built-in image generator. Its prompt is in `web/public/brand/round-three/hidden-arm-ends-edit.json`.

The active Matryoshka wordmark uses preset p12: the approved narrow Roboto Flex capitals, both T arms shortened to 55%, and custom A–T / T–R spacing. The earlier FM1 wordmarks remain historical studies. The active logo is `web/public/brand/matryoshka.png`.
