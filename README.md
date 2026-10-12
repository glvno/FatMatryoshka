# Modular-1
I always liked the concept of the Nord Modular (never used one though) so i decided to give it a try. Here we are

## Webapp

There's a Webappp here: https://wiggismodular.github.io/Modular-1/ that allows you to make patches, like you would do on a modular system and upload it to the FM-1

Modules have two parameter inputs: p1 and p2 with an attenuverter

Then there's a matrix for to map p1 and p2 as well as k1-4 to some parameter of the module. p1 and p2 are global. k1-4 only when you're on that module (see later) 

### Voices

A patch is mono unless you pick a voice count (2..8) on the Main module's card (or on the FM-1: the GLO button opens the patch page, K1 sets the voices, SAVE keeps it). Like on the Nord Modular you don't patch the voices yourself: every module that hears the Main module's pitch, gate or vel (through any chain of cables, p1 / p2 included) runs once per voice, marked `×4` on its card. Delay, reverb and output always run once and receive the sum of the voices; a module that hears no voice signal (a free-running LFO, a noise) runs once and feeds every voice. Notes take a free voice first, then the oldest sounding one. On the FM-1 each voice costs the CPU time of the per-voice modules, so 3 or 4 voices of a typical patch is the realistic range; the voices row on the Main card shows the buffer count and turns red when a patch needs more than the firmware has.

## FM-1

In addition to the modular synth engine, there's also some complex arpeggiator. 

Knobs and stuff.

* **PRESETS** scrolls trough the patches 
* **SELECT** scrolls trough the modules in the patch
* **KNOB1 - 4** do what's described
* **ARP** opens the arpeggiator's melody page (mode, scale, root note, speed)
* **SEQ** opens the arpeggiator's rhythm page (euclid steps, pulses, rotation, rate)
* **LFO** opens arpeggiator's chaos page, adds some randomness and lets select how many octaves the arpeggio spans.
* **HOME** opens the main page of the patch
* **GLO** opens the patch page: K1 sets the number of voices (the patch reloads with the new count)

## Hack it

- Run it yourself: `cd web && npm install && npm run dev`
- Build the firmware: `nix develop`, then `python3 tools/build.py`

## License

GPL-3.0-only. The flasher, loader, hardware layer and tools are copied from [Felucca](https://github.com/hugelton/Felucca) by Leo Kuroshita / Hügelton Instruments (GPL-3.0-only); see [LICENSING.md](LICENSING.md).
