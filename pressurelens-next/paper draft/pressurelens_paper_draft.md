# PressureLens: Visual Finger Pressure as an Intentional Command Channel for AI-Assisted Paper Reading

## Abstract

Printed documents remain common for deep reading, annotation, and technical study, even as large language models have become powerful tools for explanation and information seeking. Existing LLM-based reading workflows often require users to leave the physical page, type a prompt, select text on another device, or manually choose an assistance mode. This paper presents PressureLens, an augmented reality paper-reading assistant that uses finger location and visually inferred finger pressure as an in-situ command channel for LLM assistance. A tablet and mirror capture the physical page, OCR grounds the interaction in nearby text, and a lightweight vision model classifies fingertip pressure from camera-visible cues. PressureLens maps light presses to concise explanations and firm presses to detailed explanations, while a radial menu anchored near the selected word provides additional shortcuts such as definition, example, related context, and note capture. We propose two evaluations: first, a pressure-recognition study that collects labeled fingertip press data and tests both a general base model and few-shot user adaptation; second, a controlled reading study comparing pressure-based commands with an explicit menu baseline. The planned evaluation examines recognition accuracy, personalization benefit, interaction efficiency, reading comprehension, workload, and perceived interruption. PressureLens contributes a practical interaction technique for bringing intention-aware AI support into paper reading without forcing readers to switch away from the document.

## 1. Introduction

Large language models (LLMs) are increasingly used to explain difficult concepts, summarize passages, answer questions, and support learning. Tools such as chat interfaces and document assistants make digital reading more interactive, but they do not fully address physical reading workflows. Many students and researchers still read printed papers, textbooks, and manuals because paper supports focused attention, spatial memory, annotation, and comfortable extended reading. When these readers need an explanation, however, they often interrupt the reading flow by moving to a laptop or phone, typing a question, copying terms, or manually selecting text in a separate interface.

Augmented reality (AR) provides an opportunity to connect paper reading with AI assistance while preserving the physical document. A camera-equipped tablet can observe the page, OCR can identify nearby text, and generated explanations can be displayed as overlays near the relevant content. Yet an important interaction problem remains: how should the reader communicate what they want from the AI assistant without switching devices or formulating a full explicit prompt?

PressureLens explores finger pressure as a lightweight answer to this problem. During reading, pointing and touching are already natural ways to mark attention. A reader may rest a finger near a difficult term, trace along a sentence, or press on a word while thinking. We treat the location of the finger as evidence of the intended topic and the strength of the press as evidence of the intended action. In the simplest mapping, a light press requests a brief explanation and a firm press requests a more detailed explanation. A radial menu can then extend the interaction with additional commands while keeping the interface local to the selected word.

The current PressureLens prototype builds on an earlier mixed-reality paper-reading assistant. The original system used a tablet with a front-camera mirror to capture the page, OCR to extract text, finger tracking to identify reading focus, and LLM-generated overlays to provide explanations. PressureLens extends this line by replacing time-based or stylus-based depth control with visual finger-pressure inference. This makes pressure available even when the user is interacting directly with the paper rather than with a pressure-sensitive stylus or touchscreen.

This paper focuses on two research questions:

- RQ1: Can visual fingertip cues captured from a tablet camera classify no press, light press, and firm press accurately enough for real-time paper-reading interaction?
- RQ2: Does pressure-based command input make AI-assisted paper reading faster, less disruptive, or more usable than an explicit menu-based baseline?

We make three intended contributions:

- A pressure-aware AR paper-reading interaction technique that combines finger location, OCR-grounded text selection, LLM explanation, and radial menu shortcuts.
- A model evaluation plan for general visual pressure recognition and few-shot per-user adaptation.
- A controlled reading evaluation design that separates recognition accuracy from interaction benefit.

## 2. Background And Motivation

LLM-based educational support is most useful when the system understands both what the learner is attending to and what kind of help the learner wants. Prior project material frames this as an intention-aware interaction problem with two dimensions: intended topic and intended action. In paper reading, the intended topic can often be inferred from the word, phrase, or paragraph near the reader's finger. The intended action is harder. A reader might want a quick definition, a deeper conceptual explanation, an example, a note, or a summary. If the system asks the reader to manually choose all of these options every time, interaction overhead may weaken the benefit of in-situ assistance.

Finger pressure is a promising action cue because it can be performed without leaving the page. Light and firm presses are simple, memorable, and already associated with degrees of emphasis in touch interaction. Unlike Apple Pencil pressure, visual finger-pressure recognition does not require specialized pressure-sensitive hardware. The system observes the fingertip and nail region through the same camera used for page capture, making pressure input available in a low-cost AR reading setup.

The undergraduate proposal directly motivates this direction: a light press can request a brief summary or definition, while a firm press can signal desire for more detailed interpretation. The earlier PressureLens project report contributes the surrounding system design: camera capture, perspective correction, OCR, hand tracking, and AR feedback cards. The broader intention-aware AR reading proposal contributes the conceptual framing: seamless assistance should reduce explicit prompting, preserve reading flow, and connect behavioral cues to LLM output.

## 3. System Overview

PressureLens uses a tablet placed on a desk with a simple front-camera mirror to capture the printed document surface. The system processes the camera stream, corrects the paper view when needed, identifies the user's index fingertip, extracts nearby text using OCR, and displays AI-generated assistance as an overlay.

The interaction loop contains five stages:

1. Page capture and OCR. The system captures the physical page through the tablet camera and extracts word-level text and bounding boxes.
2. Finger localization. A hand-tracking model identifies the index fingertip location in the camera stream.
3. Pressure patch extraction. The system crops a small image patch around the fingertip and resizes it for pressure inference.
4. Pressure classification. A lightweight image model classifies the patch into no press, light press, or firm press.
5. LLM assistance. The selected word or local text region, pressure command, interaction history, and task mode are sent to the LLM to generate an anchored explanation.

The current implementation uses a 180 px fingertip crop and captures short image sequences during registration. A deployment workflow uses a base model trained across retained subjects and supports user-specific final-layer adaptation from a small number of registration samples. In the current registration interface, a new user collects five short sessions for each of three labels: no press, light press, and firm press. Each session lasts 3 seconds, is sampled at 10 Hz, and is saved as cropped fingertip patches. The fine-tuning script adapts the final classifier layer and exports a user-specific ONNX model for browser inference.

## 4. Interaction Design

PressureLens uses pressure as a direct command shortcut and radial menus as an expandable command layer.

The default interaction is:

- Light press on a word or phrase: request a concise explanation.
- Firm press on a word or phrase: request a detailed explanation.
- No press or hover: track focus without triggering assistance.

When the user keeps the finger near the selected term, a radial menu can appear around the touch location. The center of the menu is explanation. The four directions provide stable command families, and pressure selects the quick or deeper version within each family. A first study configuration uses:

- Up, Summarize: light press gives a one-sentence gist; firm press gives a structured local summary.
- Right, Example: light press gives one concrete example or analogy; firm press gives a worked example or application scenario.
- Down, Capture: light press saves a concise margin note; firm press creates a flashcard or quiz item and saves it.
- Left, Connect: light press defines the selected term in local context; firm press compares it with a related or commonly confused concept.

The radial menu is useful for two reasons. First, it makes the pressure interaction discoverable: the reader can see what command was inferred and correct it if needed. Second, it allows PressureLens to grow beyond brief-versus-detailed explanation without requiring a full keyboard prompt. The menu is intentionally organized as four semantic families rather than eight unrelated commands, so users only need to remember four directions while pressure controls the depth of each action.

## 5. Study 1: Visual Pressure Recognition And Personalization

### 5.1 Goal

The first study evaluates whether camera-visible fingertip cues can support reliable pressure classification for paper interaction. It also evaluates whether a general base model can be adapted to a new user with a small amount of registration data.

### 5.2 Data Collection

Participants perform repeated finger interactions on printed paper while the tablet camera records fingertip patches. Each participant completes 300 labeled trials or sessions balanced across pressure classes. A practical version is 100 no-press, 100 light-press, and 100 firm-press examples per participant. If the study uses "press" to mean only active touch, no-press examples should still be collected as negative samples during idle or hover periods because the deployed interface needs to avoid accidental activation.

For each trial, the system records:

- Pressure label: no press, light press, or firm press.
- Fingertip image patch or short image sequence.
- Hand-tracking confidence.
- Press location on the page.
- Lighting condition and paper layout if available.
- Timestamp and participant ID.

The collection should vary page location, especially vertical page position, because camera angle and mirror geometry may change fingertip appearance across the page.

### 5.3 Model

A lightweight convolutional model or MobileNet-style image classifier predicts pressure class from the fingertip patch. The base model is trained across participants and evaluated on held-out participants. Personalization is evaluated by fine-tuning only the final classifier layer using a small registration set from a new user.

The current prototype workflow uses five 3-second registration sessions per class, sampled at 10 Hz, producing roughly 150 frames per class before filtering. The registration process exports a user-specific ONNX model for browser deployment. Existing workflow notes report a base validation accuracy of 95.90 percent for a retained-subject training run; this should be replaced by the final study result after the dataset and split are fixed.

### 5.4 Metrics

Primary metrics:

- Overall accuracy.
- Macro-F1.
- Per-class precision and recall.
- Confusion matrix.
- New-user accuracy before and after few-shot adaptation.
- Inference latency in the browser.

Recommended comparisons:

- Base model without personalization.
- Base model plus 1-shot, 3-shot, and 5-shot adaptation per class.
- Leave-one-subject-out or leave-participants-out validation.
- Ablations by crop size, page location, and lighting condition.

## 6. Study 2: Reading Interaction Evaluation

### 6.1 Goal

The second study evaluates whether pressure-based commands improve the user experience of AI-assisted paper reading. Study 1 proves whether pressure can be recognized. Study 2 tests whether pressure is actually useful as an interaction technique.

### 6.2 Design

Use a within-subject, counterbalanced design with two conditions:

- PressureLens: light and firm finger presses trigger brief and detailed explanations directly; the radial menu provides additional shortcuts.
- Baseline: the same AR reading assistant, OCR, LLM, overlay, and radial menu are used, but explanation depth is selected explicitly through menu commands rather than pressure.

This baseline isolates the effect of pressure. A conventional chatbot baseline can be added as an exploratory third condition, but it should not be the only baseline because it changes too many factors at once.

Participants read matched printed passages under both conditions. Passage order and condition order are counterbalanced.

Recommended sample size:

- 24 to 32 participants for the main study.
- 16 participants as a smaller pilot.

### 6.3 Tasks

Task 1: Targeted concept lookup. Participants read a passage with target terms and use the assigned system to obtain help. After each target, they answer a multiple-choice question about the term's meaning in context. This measures time, interaction steps, and correctness.

Task 2: Explanation depth selection. Participants receive prompts that require either a brief explanation or a detailed explanation. In the pressure condition, they use light or firm press. In the baseline condition, they select depth from the menu. This directly tests whether pressure is faster and whether the model infers the intended command correctly.

Task 3: Integrated reading comprehension. Participants read a short technical passage naturally and use the assigned assistant when needed. After reading, they answer comprehension and retention questions. This tests whether the interaction supports reading rather than only command execution.

Optional Task 4: Free reading feedback. Participants use PressureLens freely for five minutes and discuss what felt natural, what felt uncertain, and which radial-menu commands they would actually use. This should be treated as qualitative feedback rather than the main quantitative evidence.

### 6.4 Measures

Objective interaction measures:

- Time from target onset to submitted answer.
- Time from assistance request to visible response.
- Number of interaction steps.
- Number of menu opens.
- Number of corrections or repeated requests.
- Pressure classification accuracy during real reading.
- OCR failures and LLM response failures.

Learning and reading measures:

- Target-question accuracy.
- Passage comprehension score.
- Definition retention score.
- Quality of notes if the note function is used.

Subjective measures:

- NASA-TLX workload.
- SUS or a short usability questionnaire.
- Perceived interruption.
- Perceived control.
- Preference ranking.
- Semi-structured interview responses.

### 6.5 Analysis

For task time, use paired comparisons or a mixed-effects model with condition as a fixed effect and participant and passage as random effects. For answer correctness, use a logistic mixed-effects model or paired nonparametric comparison depending on sample size. For questionnaire scores, compare conditions with paired t-tests or Wilcoxon signed-rank tests and report effect sizes.

The pressure-specific analysis should report not only offline model accuracy from Study 1, but also in-context command accuracy during reading. This matters because real reading includes page movement, different touch locations, partial occlusion, and user hesitation.

### 6.6 Expected Outcomes

We expect pressure commands to reduce interaction time and interaction steps for brief-versus-detailed explanation requests. We also expect similar or better comprehension compared with the baseline, because pressure should reduce overhead without reducing access to explanation. Qualitative feedback should identify whether the light/firm distinction feels natural and which radial-menu commands are worth keeping.

## 7. Discussion

PressureLens reframes finger pressure as an intentional command signal for paper-based AI assistance. In the larger intention-aware reading framework, finger position provides evidence of intended topic while pressure provides evidence of intended action. This division is useful because it lets the system answer two questions: what is the reader focusing on, and what kind of help do they want?

The pressure shortcut is intentionally simple. A two-level command mapping is easier to learn than a large gesture vocabulary and gives the model a realistic target. The radial menu then handles richer commands without overloading pressure recognition. This combination may be especially suitable for paper reading, where readers want assistance but do not want the interface to dominate the page.

## 8. Limitations And Next Steps

The current paper still needs a full related-work section with verified citations on paper reading, AR document interfaces, touch pressure, implicit intention inference, and LLM-based learning support. The current draft also uses planned-study language because final Study 1 and Study 2 results have not yet been inserted.

Immediate next writing tasks:

- Add a related-work section with real citations.
- Finalize the exact Study 1 dataset split and participant count.
- Choose the exact baseline for Study 2.
- Create study materials: passages, target terms, gold explanations, and comprehension questions.
- Replace workflow notes with final experimental results once data collection is complete.
