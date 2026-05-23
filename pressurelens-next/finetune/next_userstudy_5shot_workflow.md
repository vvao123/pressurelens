# Next User Study: 5-shot Registration Fine-tune

## Base model

The deployment base is trained from the 13 retained subjects, after excluding the bad original display ID 4 / raw subject 12.

- Base checkpoint: `D:\AR reading\newdata\training_runs\final13_all_subjects_base_crop180\final13_all_subjects_base_crop180_best_epoch22.pth`
- Base ONNX: `D:\AR reading\Patrick\temp\temp\pressure_cnn_final13_all_subjects_base_crop180.onnx`
- Base validation accuracy: `95.90%`

Training command:

```powershell
& 'C:\Users\wei wang\DL\Scripts\python.exe' '.\train_final13_base_userstudy_180.py' --epochs 30 --batch-size 32 --num-workers 2 --val-sessions-per-class 3
```

## Registration collection

For each new user, collect 5 sessions for each pressure level:

- `FirmPress`: 5 sessions
- `LightPress`: 5 sessions
- `NoPress`: 5 sessions

Total registration budget: 15 sessions. This matches the LOSO 5-shot protocol used in the report.

Prefer spreading the touch positions across the y-axis during collection when possible, because the y-coverage experiment showed a small but consistent gain.

## Per-user fine-tune

After registration data is saved as a pressure dataset, run:

```powershell
& 'C:\Users\wei wang\DL\Scripts\python.exe' '.\finetune_registered_user_180.py' --input-root 'D:\AR reading\user_study_data1.0\pressure-dataset-NEWUSER' --user-id 'NEWUSER'
```

The script automatically reads the final13 base checkpoint from `deployment_base.json`, fine-tunes only the final classifier layer, and writes:

- adapted `.pth` checkpoint
- adapted `.onnx` model
- `metrics.json` with selected sessions and fine-tune history

Default fine-tune settings:

- 5 sessions per class
- final-layer-only tuning
- 40 epochs
- learning rate `1e-3`
- weight decay `1e-4`
- batch size `16`

The registration fine-tune does not produce an independent accuracy estimate unless a separate post-registration test is collected.
