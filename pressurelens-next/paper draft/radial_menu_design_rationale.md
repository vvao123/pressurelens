# PressureLens Radial Menu Design Rationale

## Design Decision

The radial menu should not contain eight unrelated commands. It should contain four stable directional command families, with light press and firm press acting as two levels within each family. This preserves spatial memory while still giving the system eight possible actions.

Center action:

- Light press: simple explanation.
- Firm press: detailed explanation.

Directional actions:

| Direction | Family | Light press | Firm press | Rationale |
|---|---|---|---|---|
| Up | Summarize | One-sentence gist of the nearby sentence or paragraph. | Structured local summary with 3 to 5 key points. | Maps to digital-document AI functions such as summaries, briefings, and source overviews. Up also works as a "big picture" spatial metaphor. |
| Right | Example | Give one concrete example or analogy. | Give a worked example or application scenario that explains how the idea is used. | Helps readers move from abstract text to applied understanding. Right suggests forward motion or continuation. |
| Down | Capture | Save a concise margin note anchored to the selected text. | Create a study item, such as a flashcard or quiz question, and save it to notes. | Matches note-taking and study-guide workflows in NotebookLM-like systems. Down suggests pinning or saving. |
| Left | Connect | Define the selected term in local context. | Compare it with a related or commonly confused concept, or connect it to earlier text. | Supports source-grounded clarification and concept linking. Left suggests looking back to context. |

This gives eight directional commands:

1. Up-light: quick gist.
2. Up-firm: structured summary.
3. Right-light: simple example.
4. Right-firm: worked example/application.
5. Down-light: save margin note.
6. Down-firm: create flashcard/quiz item.
7. Left-light: contextual definition.
8. Left-firm: compare/connect concept.

## Why This Is Better Than Eight Independent Options

Pressure is already a hidden or semi-hidden input dimension. If light and firm presses map to unrelated functions, users must memorize both direction and pressure as arbitrary labels. Instead, each direction should represent a stable semantic family, and pressure should control depth, effort, or transformation strength within that family.

This also matches the core claim of PressureLens:

- Finger location expresses intended topic.
- Pressure expresses intended action depth.
- Radial direction expresses action family.

## Interaction Mechanics

Recommended interaction sequence:

1. User touches or presses a word or phrase.
2. Quick release executes the center action:
   - light press gives simple explanation;
   - firm press gives detailed explanation.
3. Holding for approximately 500 to 700 ms opens the radial menu.
4. The menu appears around the selected word with four cardinal directions.
5. The current pressure layer is visually highlighted:
   - inner/light layer for quick actions;
   - outer/firm layer for deeper actions.
6. User slides toward a direction and releases.
7. If pressure confidence is low, the system asks for confirmation or defaults to the light variant.

Important detail: pressure should act as a modifier inside a direction, not as a separate second menu. The user should feel that "right means example" and pressure only chooses "quick example" vs "worked example."

## Literature Grounding

Marking menus support the menu structure. Kurtenbach and Buxton describe marking menus as radial menus that novices can wait to reveal and experts can select by direction. They also define four-direction "compass4" and eight-direction "compass8" layouts, which supports the choice of stable compass directions.

Finger-based radial selection supports using four cardinal directions first. Work on radial finger sliding reports that errors increase as menu breadth and depth increase, and that even one-layer eight-direction menus can have noticeable errors. This argues for four visible directions in PressureLens, especially because the finger may occlude part of the menu on paper.

Pressure-input work supports a two-level pressure design. Studies of two-level force input use light and heavy press targets and show the importance of feedback for learning force thresholds. This supports keeping PressureLens pressure levels simple and showing immediate visual feedback.

NotebookLM-like tools justify the command families. Official NotebookLM help describes source-grounded chat with citations and transformations into study guides, briefings, audio overviews, mind maps, flashcards, quizzes, and notes. PressureLens should adapt these digital-document functions to paper reading, but only keep the commands that are useful at a word or paragraph scale.

AR/MR note-taking systems justify the capture family. GazeNoter uses AR and LLM-generated suggestions while keeping the user in control of note content. MaRginalia similarly addresses the problem that device-based note-taking can distract students from the live material. PressureLens can use pressure and radial commands to provide this same low-interruption capture workflow for printed documents.

Print-reading studies justify the overall problem. ARFIS reports that large majorities of tertiary students prefer print for academic texts and believe it supports focus and memory. PressureLens should therefore preserve the paper workflow and add AI functions without forcing a switch to a digital document interface.

## Sources

- Kurtenbach, G. and Buxton, W. The Limits of Expert Performance Using Hierarchic Marking Menus. InterCHI 1993. https://www.billbuxton.com/MMExpert.html
- Huang et al. A mechanism based on finger-sliding behavior for designing radial menus. International Journal of Industrial Ergonomics, 2019. https://www.sciencedirect.com/science/article/abs/pii/S0169814119301271
- Taher et al. An empirical characterization of touch-gesture input force on mobile devices. ITS 2014. https://eprints.lancs.ac.uk/id/eprint/71817/
- Sheik-Nainar et al. Two-level Force Input on TouchPad and the Effects of Feedback on Performance. Proceedings of the Human Factors and Ergonomics Society Annual Meeting, 2013. https://journals.sagepub.com/doi/abs/10.1177/1541931213571234
- Google NotebookLM Help. Learn about NotebookLM. https://support.google.com/notebooklm/answer/16164461?hl=en
- Google NotebookLM Help. Create and add notes in NotebookLM. https://support.google.com/notebooklm/answer/16262519?hl=en
- Tsai et al. GazeNoter: Co-Piloted AR Note-Taking via Gaze Selection of LLM Suggestions to Match Users' Intentions. arXiv 2024. https://arxiv.org/abs/2407.01161
- Qiu et al. MaRginalia: Enabling In-person Lecture Capturing and Note-taking Through Mixed Reality. arXiv 2025. https://arxiv.org/abs/2501.16010
- Mizrachi et al. Beyond the Surveys: Qualitative Analysis from the Academic Reading Format International Study. College and Research Libraries, 2021. https://crl.acrl.org/index.php/crl/article/view/24513/32347

