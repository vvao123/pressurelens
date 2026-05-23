from __future__ import annotations

import argparse
import contextlib
import importlib.util
import io
import json
import random
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

import torch


ROOT = Path(r"D:\AR reading")
RUNS_ROOT = ROOT / "newdata" / "training_runs"
RUN180_PATH = ROOT / "Patrick" / "temp" / "temp" / "run_180_training_experiments.py"
DEFAULT_BASE_JSON = RUNS_ROOT / "final13_all_subjects_base_crop180" / "deployment_base.json"
CLASS_NAMES = ["FirmPress", "LightPress", "NoPress"]
CLASS_TO_IDX = {name: idx for idx, name in enumerate(CLASS_NAMES)}
RAW_TO_CLASS = {"firm": "FirmPress", "light": "LightPress", "no_press": "NoPress"}


def load_module(module_name: str, path: Path):
    module_dir = str(path.parent)
    if module_dir not in sys.path:
        sys.path.insert(0, module_dir)
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load module from {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


def sanitize(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", value.lower()).strip("_")


def parse_image_name(path: Path) -> tuple[str, str] | None:
    stem = path.stem
    if not stem.startswith("pressure-collect-"):
        return None
    try:
        prefix, _frame = stem.rsplit("-", 1)
    except ValueError:
        return None
    parts = prefix.split("-")
    if len(parts) < 5:
        return None
    raw_label = "-".join(parts[2:-2]).replace("-", "_")
    class_name = RAW_TO_CLASS.get(raw_label)
    if class_name is None:
        return None
    return prefix, class_name


def patches_root_for(input_root: Path) -> Path:
    if (input_root / "patches").is_dir():
        return input_root / "patches"
    crop_patches = input_root.parent / f"{input_root.name}_crop180" / "patches"
    if crop_patches.is_dir():
        return crop_patches
    if input_root.name.endswith("_crop180") and (input_root / "patches").is_dir():
        return input_root / "patches"
    raise RuntimeError(f"Could not find patches under {input_root}")


def collect_samples(run180, input_root: Path, source_name: str):
    patches_root = patches_root_for(input_root)
    samples = []
    rows = []
    for image_path in sorted(patches_root.glob("*.jpg")):
        parsed = parse_image_name(image_path)
        if parsed is None:
            continue
        session_key, class_name = parsed
        samples.append(
            run180.Sample(
                path=image_path,
                label_name=class_name,
                label_idx=CLASS_TO_IDX[class_name],
                source_name=source_name,
                session_key=session_key,
            )
        )
        rows.append(
            {
                "path": str(image_path),
                "source": source_name,
                "class_name": class_name,
                "label_idx": CLASS_TO_IDX[class_name],
                "session_key": session_key,
            }
        )
    if not samples:
        raise RuntimeError(f"No valid pressure patch jpg files found under {patches_root}")
    return samples, rows, patches_root


def select_registration_indices(rows: list[dict], shots_per_class: int, selection: str, seed: int):
    rng = random.Random(seed)
    by_class: dict[str, dict[str, list[int]]] = {class_name: defaultdict(list) for class_name in CLASS_NAMES}
    for idx, row in enumerate(rows):
        by_class[row["class_name"]][row["session_key"]].append(idx)

    selected: set[int] = set()
    selected_units: dict[str, list[str]] = {}
    for class_name in CLASS_NAMES:
        sessions = sorted(by_class[class_name])
        if len(sessions) < shots_per_class:
            raise RuntimeError(
                f"{class_name} has {len(sessions)} sessions; need {shots_per_class} for registration."
            )
        if len(sessions) == shots_per_class:
            picked = sessions
        elif selection == "first":
            picked = sessions[:shots_per_class]
        elif selection == "random":
            picked = sorted(rng.sample(sessions, shots_per_class))
        else:
            raise ValueError(f"Unknown selection strategy: {selection}")
        selected_units[class_name] = picked
        for session in picked:
            selected.update(by_class[class_name][session])
    return selected, selected_units


def load_model(run180, checkpoint_path: Path, device):
    checkpoint = torch.load(checkpoint_path, map_location=device)
    model = run180.PressureCNN180(num_classes=len(CLASS_NAMES)).to(device)
    model.load_state_dict(checkpoint["model_state"])
    return model, checkpoint


def freeze_for_final_layer_tuning(model) -> None:
    for parameter in model.parameters():
        parameter.requires_grad = False
    for parameter in model.classifier[-1].parameters():
        parameter.requires_grad = True


def train_final_layer(run180, model, train_loader, device, epochs: int, lr: float, weight_decay: float):
    freeze_for_final_layer_tuning(model)
    model.eval()
    criterion = torch.nn.CrossEntropyLoss()
    optimizer = torch.optim.AdamW(model.classifier[-1].parameters(), lr=lr, weight_decay=weight_decay)
    history = []
    for epoch in range(1, epochs + 1):
        running_loss = 0.0
        running_correct = 0
        running_total = 0
        model.eval()
        for images, targets, _, _ in train_loader:
            images = images.to(device, non_blocking=True)
            targets = targets.to(device, non_blocking=True)
            optimizer.zero_grad(set_to_none=True)
            outputs = model(images)
            loss = criterion(outputs, targets)
            loss.backward()
            optimizer.step()
            running_loss += loss.item()
            running_correct += (outputs.argmax(1) == targets).sum().item()
            running_total += targets.size(0)
        history.append(
            {
                "epoch": epoch,
                "train_loss": running_loss / max(len(train_loader), 1),
                "train_acc": running_correct / max(running_total, 1) * 100.0,
            }
        )
        print(
            f"fine-tune | epoch {epoch:02d}/{epochs} | "
            f"train_loss={history[-1]['train_loss']:.4f} "
            f"train_acc={history[-1]['train_acc']:.2f}%",
            flush=True,
        )
    return history


def export_checkpoint_to_onnx(run180, checkpoint_path: Path, output_path: Path) -> None:
    checkpoint = torch.load(checkpoint_path, map_location="cpu")
    model = run180.PressureCNN180(num_classes=len(checkpoint["class_names"]))
    model.load_state_dict(checkpoint["model_state"])
    model.eval()
    dummy = torch.randn(1, 3, 180, 180, dtype=torch.float32)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with contextlib.redirect_stdout(io.StringIO()):
        torch.onnx.export(
            model,
            dummy,
            output_path,
            input_names=["input"],
            output_names=["output"],
            opset_version=18,
            dynamic_axes={"input": {0: "batch"}, "output": {0: "batch"}},
            external_data=False,
        )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-root", type=Path, required=True)
    parser.add_argument("--user-id", required=True)
    parser.add_argument("--base-checkpoint", type=Path, default=None)
    parser.add_argument("--shots-per-class", type=int, default=5)
    parser.add_argument("--selection", choices=["first", "random"], default="first")
    parser.add_argument("--epochs", type=int, default=40)
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--num-workers", type=int, default=0)
    parser.add_argument("--lr", type=float, default=1e-3)
    parser.add_argument("--weight-decay", type=float, default=1e-4)
    parser.add_argument("--seed", type=int, default=20260516)
    parser.add_argument("--output-root", type=Path, default=RUNS_ROOT / "next_userstudy_registered_finetunes")
    args = parser.parse_args()

    if args.base_checkpoint is None:
        if not DEFAULT_BASE_JSON.is_file():
            raise RuntimeError(
                f"Base checkpoint was not provided and deployment metadata was not found: {DEFAULT_BASE_JSON}"
            )
        args.base_checkpoint = Path(json.loads(DEFAULT_BASE_JSON.read_text(encoding="utf-8"))["checkpoint"])

    if not args.base_checkpoint.is_file():
        raise RuntimeError(f"Base checkpoint not found: {args.base_checkpoint}")

    torch.manual_seed(args.seed)
    torch.cuda.manual_seed_all(args.seed)
    run180 = load_module("run_180_training_experiments", RUN180_PATH)
    run180.NUM_WORKERS = int(args.num_workers)
    run180.BATCH_SIZE = int(args.batch_size)

    run_name = f"registered_{sanitize(args.user_id)}_5shot_final_layer_crop180"
    output_dir = args.output_root / run_name
    output_dir.mkdir(parents=True, exist_ok=True)

    samples, rows, patches_root = collect_samples(run180, args.input_root, args.user_id)
    selected_idx, selected_units = select_registration_indices(
        rows,
        shots_per_class=int(args.shots_per_class),
        selection=args.selection,
        seed=int(args.seed),
    )
    selected_samples = [samples[idx] for idx in sorted(selected_idx)]

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    train_transform, _eval_transform = run180.build_transforms()
    _, train_loader = run180.make_loader(
        selected_samples,
        train_transform,
        args.batch_size,
        use_amp=device.type == "cuda",
        train=True,
    )
    model, base_payload = load_model(run180, args.base_checkpoint, device)
    history = train_final_layer(
        run180,
        model,
        train_loader,
        device,
        epochs=int(args.epochs),
        lr=float(args.lr),
        weight_decay=float(args.weight_decay),
    )

    checkpoint_path = output_dir / f"{run_name}.pth"
    torch.save(
        {
            "model_state": model.state_dict(),
            "class_names": CLASS_NAMES,
            "input_size": 180,
            "run_name": run_name,
            "base_checkpoint": str(args.base_checkpoint),
            "base_epoch": base_payload.get("epoch"),
            "user_id": args.user_id,
            "selected_units": selected_units,
            "history": history,
        },
        checkpoint_path,
    )
    onnx_path = output_dir / f"{run_name}.onnx"
    export_checkpoint_to_onnx(run180, checkpoint_path, onnx_path)

    metrics = {
        "workflow": "next_userstudy_registration_5shot_final_layer_finetune",
        "user_id": args.user_id,
        "input_root": str(args.input_root),
        "patches_root": str(patches_root),
        "base_checkpoint": str(args.base_checkpoint),
        "checkpoint": str(checkpoint_path),
        "onnx": str(onnx_path),
        "shots_per_class": args.shots_per_class,
        "selection": args.selection,
        "selected_sessions": selected_units,
        "selected_samples": len(selected_samples),
        "selected_class_counts": dict(Counter(sample.label_name for sample in selected_samples)),
        "history": history,
        "note": "This registration fine-tune has no independent accuracy estimate unless a separate post-registration test is collected.",
    }
    (output_dir / "metrics.json").write_text(json.dumps(metrics, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"Checkpoint: {checkpoint_path}")
    print(f"ONNX      : {onnx_path}")
    print("Note      : no independent test accuracy is computed in registration fine-tune.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
