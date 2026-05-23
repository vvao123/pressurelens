# Experiment 2 Design Memo

## Core Recommendation

Use a controlled within-subject reading study as the main evaluation, with a short free-reading segment at the end for qualitative feedback. The controlled study gives measurable evidence for efficiency, workload, and reading outcome. The free-reading segment is still useful, but should be framed as formative feedback on comfort, radial-menu layout, and perceived naturalness.

The key comparison should isolate the pressure interaction itself:

- Condition A: PressureLens with visual pressure commands. A light press requests a concise explanation, a firm press requests a detailed explanation, and a radial menu provides four additional shortcuts.
- Condition B: Non-pressure baseline with the same camera, OCR, LLM, and AR overlay. The user taps or holds a word to open the same radial menu and explicitly selects "brief" or "detailed" from the menu.

This is stronger than comparing against a completely separate chatbot workflow because both conditions share the same AR reading assistant. The main behavioral difference is whether pressure acts as a command channel.

## Research Questions

RQ1. Does pressure-based interaction reduce the time and number of interaction steps needed to obtain an appropriately detailed explanation while reading printed material?

RQ2. Does pressure-based interaction preserve or improve comprehension compared with an explicit menu-based baseline?

RQ3. Does the interaction feel natural, controllable, and low effort during paper reading?

RQ4. In realistic reading tasks, how often does the pressure model infer the intended command correctly, and how often do users need to correct the command?

## Hypotheses

H1. Participants will complete explanation-seeking tasks faster with PressureLens than with the non-pressure baseline.

H2. Participants will require fewer explicit interaction steps with PressureLens because explanation depth can be conveyed through press strength.

H3. Comprehension accuracy will be similar or higher with PressureLens, because faster access should not trade off against understanding.

H4. Participants will report lower workload and lower interruption with PressureLens.

## Participants

Recommended target: 24 to 32 participants for a within-subject HCI study.

Minimum workable target: 16 participants for a pilot-style paper if recruitment is limited.

Eligibility:

- Normal or corrected-to-normal vision.
- Comfortable reading English technical passages.
- No requirement for prior AR or LLM experience.

Collect background variables:

- Frequency of reading printed academic material.
- Familiarity with LLM tools.
- Familiarity with tablet-based annotation or AR tools.
- Self-rated comfort with technical reading.

## Materials

Prepare two or four matched printed passages. Each passage should be around 600 to 900 words, technical enough to create real explanation needs, but not so hard that users give up. Good passage types:

- A short science or engineering explanation with 10 to 14 domain terms.
- A research-paper-style excerpt with definitions, mechanisms, and comparisons.
- A textbook-like passage with causal structure and unfamiliar terms.

Each passage should have:

- 8 to 12 target terms or phrases.
- A ground-truth brief explanation for each target.
- A ground-truth detailed explanation for each target.
- 6 to 10 comprehension questions.
- A difficulty rating from pilot readers, so passages can be balanced across conditions.

Counterbalance passage order and condition order:

- Half of participants use PressureLens first.
- Half use the baseline first.
- Each passage appears equally often in each condition.

## Task Blocks

### Task 1: Targeted Concept Lookup

Purpose: Measure interaction efficiency for common reading support.

Participant instruction:

"Read the passage. When you encounter a highlighted target term, use the assigned system to get help and choose the answer that best matches the term's meaning in this passage."

Trial structure:

1. Participant reads until reaching a target term.
2. Participant requests help using the assigned condition.
3. Participant selects one answer from four choices.
4. The system logs timing and interaction behavior.

Recommended number:

- 8 trials per condition.
- 16 total targeted lookup trials per participant.

Primary metrics:

- Time from target onset to accepted answer.
- Number of interaction steps.
- Number of incorrect or repeated requests.
- Answer correctness.
- Whether the explanation depth matched the task need.

### Task 2: Explanation Depth Selection

Purpose: Directly test the central pressure idea: light press for simple explanation, firm press for detailed explanation.

Participant instruction:

"For each prompt, request either a brief explanation or a detailed explanation, depending on what the task asks you to understand."

Example prompts:

- "Get a brief definition of this term."
- "Get a detailed explanation of how this mechanism works."
- "Get a quick example of this concept."
- "Get a deeper explanation that connects this term to the previous paragraph."

Condition behavior:

- PressureLens: light press should produce brief output; firm press should produce detailed output.
- Baseline: user opens the menu and explicitly selects brief or detailed.

Recommended number:

- 10 trials per condition.
- 20 total depth-selection trials per participant.

Primary metrics:

- Command completion time.
- Correct depth selection.
- Pressure classification accuracy in context.
- Correction rate.
- User confidence rating after each block.

### Task 3: Integrated Reading And Comprehension

Purpose: Measure whether the interaction actually supports reading, not just command execution.

Participant instruction:

"Read the passage naturally. You may use the assigned system whenever you need clarification. After reading, answer comprehension questions without looking back."

Recommended duration:

- 8 to 10 minutes per condition.

Outcome measures:

- Comprehension quiz score.
- Retention of definitions.
- Number of assistance requests.
- Total time spent interacting with the assistant.
- Self-reported interruption.
- NASA-TLX workload.
- SUS or a short usability questionnaire after each condition.

### Optional Task 4: Free Reading Feedback

Purpose: Explore design refinements for the radial menu and discover interaction issues not captured by timed tasks.

Participant instruction:

"Read freely for five minutes. Use the system whenever it feels useful. Think aloud if you are comfortable."

Collect:

- Preferred radial-menu shortcuts.
- Perceived distinction between light and firm press.
- Whether users worry about accidental activation.
- Whether explanations appear at the right location and length.
- Suggestions for menu labels and layout.

This task should be qualitative, not the main evidence for efficiency or learning.

## Radial Menu Design For The Study

Recommended center action:

- Explanation. The center output changes based on pressure: brief for light press, detailed for firm press.

Recommended four directional families:

- Up, Summarize: light press gives a one-sentence gist; firm press gives a structured local summary.
- Right, Example: light press gives one concrete example or analogy; firm press gives a worked example or application scenario.
- Down, Capture: light press saves a concise margin note; firm press creates a flashcard or quiz item and saves it.
- Left, Connect: light press defines the selected term in local context; firm press compares it with a related or commonly confused concept.

This keeps the menu at four visible directions while still supporting eight directional actions. The four directions should be stable across all study tasks. Pressure should act as a depth or transformation modifier within each direction, not as a set of unrelated hidden commands.

Recommended interaction sequence:

- Quick release executes the center explanation action.
- Holding for approximately 500 to 700 ms after pressure detection opens the radial menu.
- The menu shows the current pressure layer visually, so users can see whether the system is interpreting the action as light or firm.
- Sliding toward a direction and releasing executes the selected family/action.
- If pressure confidence is low, the system should ask for confirmation or default to the light variant.

Keep the menu identical across both conditions. In the pressure condition, pressure provides a shortcut to explanation depth. In the baseline, the user manually chooses depth from the menu.

## Logged Data

Log each interaction as a structured event:

- participant_id
- condition
- passage_id
- task_id
- trial_id
- target_word
- expected_depth
- predicted_pressure_class
- user_selected_action
- final_action_executed
- timestamp_start
- timestamp_assistance_requested
- timestamp_response_visible
- timestamp_answer_submitted
- number_of_menu_opens
- number_of corrections
- OCR confidence
- LLM response length
- answer_correct

For pressure-specific analysis:

- raw pressure probability distribution
- fingertip crop quality flag
- hand tracking confidence
- press duration
- press location on page
- whether the participant overrode the command

## Analysis Plan

Use participant-level paired comparisons or mixed-effects models.

Primary model for time:

- Dependent variable: log task completion time.
- Fixed effect: condition.
- Random effects: participant and passage.

Primary model for accuracy:

- Dependent variable: correct or incorrect answer.
- Fixed effect: condition.
- Random effects: participant and passage.

Additional analyses:

- Compare number of interaction steps between conditions.
- Compare NASA-TLX and SUS scores between conditions.
- Report pressure command accuracy, macro-F1, and confusion matrix during realistic use.
- Report qualitative themes from interviews and free reading.

## Why This Design Works

This experiment separates two claims:

1. The model claim: visual pressure can classify user command intent accurately enough for interaction.
2. The interaction claim: pressure makes AR paper reading assistance faster, less disruptive, or more natural than explicit menu selection.

Study 1 addresses the model claim. Study 2 addresses the interaction claim. Together they make the paper much cleaner than a single free-reading feedback study.
