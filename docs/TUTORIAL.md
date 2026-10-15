# Tutorial design

The course has eleven chapters. Each teaches a synthesis idea through a playable patch and a practical editor technique. This document records the QA revisions requested on 2026-10-14; implementation tickets are [#23–#35](https://github.com/glvno/matryoshka/issues?q=is%3Aissue+label%3Aready-for-agent).

## Progress and recovery

The course is data: `web/src/tutorial/course.json`, written by the lesson editor and compiled by `chapters.ts` (shape in `course-schema.ts`, part semantics in `parts.ts`, code-only checks and roles in `registry.ts`). A **task** step shows a checklist of its requirements (parts) and advances after 900 ms when they are met; with **Wait for Continue** (`listen`) it waits for **Continue**. A **Continue** step has no requirements: it breaks up text or is a listening break (optionally with the playback buttons and a pointer at a module, jack, slider or sidebar control). Creative comparisons are ungraded; their text distinguishes optional settings from the settings needed for the next exercise. Frame resizing is explicitly optional.

There is no "do it for me". **Back** restarts the previous step from the patch the learner had when entering it (kept in memory per step of the chapter; after a reload, the canned beginning state); the current patch is kept as a variation first.

A later matching state never makes a preparatory step moot: a newly grouped, collapsed assembly is not evidence that the learner expanded it. Structural prerequisites that are still relevant must hold before advancing or finishing; when one no longer holds the panel says so (put it back, or go Back). `superseded` marks work deliberately replaced later. A step is transient (skipped when judging whether a finished patch completes a chapter) when it is a Continue step or any requirement is momentary: an event, a slider "moved from its start", a resize, a save, or a custom check marked momentary.

Checklists name the missing work and point to its controls. Close cancels pending advances and audition; Resume restarts polling. The saved page and stable step ID survive reload, with a fresh entry snapshot for delta-based checks.

Every chapter loads a prepared starting patch. Before replacing the open patch, the runtime stores an immutable variation in `matryoshka.tutorial.variations`, including patches whose names begin with Tutorial. This archive is independent of the 32-slot hardware upload bank. It never evicts or replaces a different same-named version. A storage failure is shown and leaves the open patch in place. Named sketches can also be saved during any exercise or at chapter completion. **Tutorial → Your saved variations → Restore** first keeps the current patch, then restores the selected copy.

Assembly saves go to the real library. Helper saves retain a changed prior instrument under a unique “previous” name and leave one active tutorial tag; failed storage writes are reported. A fresh save check compares the definition actually saved during the step with the current assembly, including its modules, cables and exposed controls; saving an unrelated assembly does not count. Later chapters use the learner's tagged or named instrument when available, otherwise the bundled version: the definition stored with the reference patch of the step that saves it.

Every task step stores a **reference patch**, the patch after doing it. A step's beginning state is the previous task step's reference (or the chapter's start: a new patch, the previous chapter's end, a factory patch, or a stored patch); a chapter's end, its intro preview and its Examples entry are its last reference.

## Listening and panel behavior

Every exercise and chapter finish has Note, Chord and a repeating Riff. These are toggles; **Release notes** lets tails decay, while **Stop** silences playback, including autonomous patches. Chord respects Main's voice count; chapter 8 starts with four voices. Navigation, close, blur and Panic cancel tutorial notes and timers. A cancelled audio startup cannot restart playback afterward.

An intro's **Preview the finished sound** sends the completed patch to the audio engine for eight seconds without changing the editor patch, layout, history, selection, snapshots or library. Normal preview completion restores the editor sound and previous transport/mute state. Explicit Stop, blur and close silence it. Audio starts from a playback click.

The panel docks at bottom right by default. **Follow** optionally places it near the highlighted target and scrolls that target into view. Drag the handle, or use its arrow keys to move it; Home docks it again. Below 650 px it docks immediately at the bottom, clears desktop inline positions and scrolls internally. Reduced-motion preferences suppress movement and pulsing. Required controls, then the optional Why, then expected listening outcomes keep the lesson readable.

## Chapter payoffs

| Chapter | Build and audible payoff |
| --- | --- |
| 1. Hello sound | Bare oscillator to Output first (an endless drone, a listening step), then a VCA in between silences it until Main gate opens its cv; compare sine, saw and square on the same riff without a timer rushing the choice. |
| 2. Shaping a note | Swelling attack/release versus a fast, zero-sustain pluck; the held pluck really dies. |
| 3. Subtractive voice | Separate cutoff and resonance listening; keyboard tracking, slow wah versus rhythmic wobble, then knob routing and live/base values. |
| 4. Your first assembly | Fold five modules into one instrument, expand explicitly, promote two controls, optionally resize, then save the current instrument. |
| 5. An effect assembly | Insert and audition Delay, Reverb and Chorus separately before grouping. Compare dry, small room and large space. |
| 6. Second instrument: FM | Hear the gated carrier before modulation. Manually duplicated oscillators need a new pitch cable; helper repairs partial work. Compare mellow/hollow/metallic ratios, then envelope and nested space. |
| 7. Plucked and struck | Hear the string and modal body before adding noise through a comb. Compare muted/ringing chords and breathy tone; save Pluck. |
| 8. Wavetables and grains | Hear a gated dry vowel first; keep an output through every insert. Capture a four-note chord, freeze it, explore pitch/spray and return to live input. |
| 9. Two instruments | Solo and blend layers. Map a full-depth knob to 150–4000 Hz. Compare snapshots, then explicitly choose Snapshot B as a compatible morph target and move Main morph. |
| 10. Melody machine | Listen to chance before writing a reply. Sequence changes and instrument gates share the musical subdivision; a second divider derives every-other-note FM triggers after 24-ppqn conversion. Divider outputs retain input pulse width. |
| 11. Drums and performance | A held hat dies with the documented levels/rates. Mix through a loose mixer outside factory drums. Place kick/snare beats with sequencers, then build an eight-bar arrangement using the saved Pluck. |

Each finish names a specific accomplishment, offers an optional creative challenge, and lets the learner name a variation. The finale is an ordinary shareable patch within the 32-module limit: two bars of beat, four with melody, an open-hat flourish on bar seven, then a return. A divider and slow sequencer store the form; no browser timer is needed. The arrangement reuses the kick sequence for melody and drives hats with the eighth-note clock. Engine sequencers advance on the first edge, so the first sounding slot is s2, then s3…s8, s1. The pattern builder accounts for that phase explicitly.

## QA boundaries

Course tests run the validator over `course.json`, check every step's checklist and highlight on its beginning state and its reference, render sound from every chapter's end, and test capture against the course's own reference patches. Regressions cover manual duplication, nested factory mixers, held-note envelope tails, audible intermediate patches, real morph targets and macro units, the clock hierarchy, stale library saves, the actual eight-bar control sequence, audition cancellation and immutable variation storage/failure.

Browser checks exercise close/resume, reload at a delta-based step, assembly expansion, deliberate Continue, playback controls, preview, saved variations and desktop/mobile docking. Browser audio lifecycle is separate from DSP tests; neither is a claim of firmware or device validation. The existing development server on port 5173 is used; do not start a second server.

## Fixed links

Dedicated parameter inputs remain permanently linked (`ParamDef.input`). Their routes are grey and inert; user-made routes remain editable. This tutorial revision changes browser behavior and course patches, not the firmware patch format or DSP definitions.

## Writing lessons locally

Run the usual `cd web && npm run dev`, then choose **Edit lessons** at the bottom of the synth sidebar, or open <http://localhost:5173/lesson-editor>. The existing server on 5173 serves the editor; no separate process is needed. Keep the synth open in another tab of the same server: the editor links to it.

**Structure.** The course browser lists chapters and their steps; drag to reorder (steps within their chapter), or use ↑ / ↓. A chapter page edits its title, patch name, start (new patch with a voice count, previous chapter's end, factory patch, or the synth's current patch stored), introduction, payoff and challenge, and adds steps at its start. A step page adds a task or Continue step after it, duplicates or deletes it. Ids are made from the title once and never change; learners' progress follows them.

**Requirements.** A task step is a list of parts, built from module definitions: module present, cable, cable removed, slider (≤ ≥ = ≠ between, or moved from its start, in the parameter's units), routed to a parameter (a thumb drop), pin map, attenuverter, macro range, assembly (exists, expanded, collapsed, promoted slider, exposed output, merged inputs, contains, resized, saved), voices, event (notes, undo, zoom, probe, selection, bypass…), sound (sounds with a key held / silent without a key, rendered offline) and custom checks from `registry.ts`. Parts name modules by shape, never by id: the n-th of a type (or every one, or the one outside assemblies), a module role, or a type inside an assembly role. Each part writes its own checklist line; an optional override replaces it. **Roles** (a page of its own) name assemblies by the types they contain or their library name, and modules inside them; code roles (carrier, modulator) live in `registry.ts`.

**The synth link.** With the synth open, every requirement shows ✓ / ✗ against the synth's patch and the preview's checklist lists what is missing. **Try this step in the synth** loads the step's beginning state. **Record in the synth** loads it, the author does the step, **Stop recording** lists what changed (modules, cables added and removed, sliders as at least / at most the new value, routes, assembly changes, events) to tick into requirements, and keeps the result as the step's reference patch (and an assembly saved meanwhile as the bundled copy). Re-recording a step with recorded steps after it says so; Course checks shows any that no longer hold. The link is a `BroadcastChannel` between same-origin tabs (`link.ts`), development only.

**Course checks** run on every change (`validate.ts`): every part names types, ports, parameters, roles and checks that exist; every reference patch passes its own step (momentary parts aside) and every earlier structural step of its chapter; a saving step stores its definition; each chapter's end completes it; required text is not empty. Errors block **Save all changes** (Cmd/Ctrl+S), which writes `web/src/tutorial/course.json` (reference patches one per line); a task step without a reference is a warning, a step that a later one undoes without being marked superseded a hint. The local synth reloads after a save, while the editor keeps its position. Saving does not commit or publish anything.

Every prose field supports Markdown; titles remain plain text. Open **Markdown formatting guide** above the fields for examples. Markdown supports **bold**, *italics*, strikethrough, inline code, links, headings, bullet and numbered lists, quotations, fenced code blocks, tables, images, footnotes, and horizontal rules. Blank lines separate paragraphs; single newlines remain visible line breaks. Prose headings appear below the lesson title in the document hierarchy. Web links open in a new tab so they leave the learner's patch open. Raw HTML is displayed literally; executable URL schemes are rejected. `web/src/tutorial/markdown.ts` provides the same parser, DOM wrapper and challenge layout to the runtime and preview, with shared `.tutorial-prose` styles. Wide tables and code blocks scroll inside the card, and images fit its width.

Footnotes use `A detail.[^note]` with `[^note]: The explanation.` below, or an inline note such as `A detail.^[The explanation.]`. Put the reference and definition in the same field; each field numbers its own notes. Indent additional paragraphs by four spaces. Notes can contain ordinary Markdown. Clicking a note number scrolls to its explanation; each return arrow goes back to its reference, including repeated references. Navigation keeps the current patch URL and stays in the lesson. Generated IDs are unique across fields, so Instructions and Why can both use `[^1]`.

Drafts are kept in browser storage as you type. Each tab retains its own draft across reloads; the most recently edited draft is also available when reopening the editor. **Download draft** exports a recovery copy. **Reload saved course…** explicitly discards the current draft after an inline confirmation. If the file changed outside this editor or another tab saved first, saving is refused: download your draft, reload the saved course, then reconcile your edits. Storage failures remain visible; keep a download before closing if recovery is unavailable.

The GUI is served only by the Vite development server. Its fixed-path JSON save endpoint accepts local, same-origin requests, checks the course's shape (`validateShape`) and the source revision, and writes atomically. Neither the GUI, sidebar link nor save endpoint is included in the production site or Vite preview server.
