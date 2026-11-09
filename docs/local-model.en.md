# Local models with mistral-gui

Install [mistral-gui](https://github.com/shusfun/mistral-gui/releases/latest). It uses Wails v3.1.0 on Windows x64, Intel macOS and Apple Silicon. Closing hides to the tray; explicit Quit stops the manager and every engine. The manager, inference runtimes and model weights are separate downloads.

Browse compatible HY-MT, Qwen3 and SmolLM3 GGUF/safetensors models. Install a runtime and model, create a deployment with a unique ID and optionally apply resource recommendations. Deployments start and stop independently; their count is not capped by the manager. Model chat remains in the official mistral.rs WebUI.

In Qingyi settings, enter `http://127.0.0.1:19820`, the manager token and a deployment ID. Refresh the local deployment list to select an instance, or type its ID manually. A blank token preserves the saved token. Save and grant localhost permission when prompted. Match the backend or use Auto.

Local-first falls back to the configured cloud service for individual failed paragraphs. Local-only never falls back; cloud-only does not contact the manager. Dictionary and user-correction hits do not start an engine. Local inference uses a separate 256 MiB cache keyed by model revision and deployment configuration; dictionary and corrections are retained independently.

Manager updates use Wails with signed artifacts and health recovery. Existing users of an overwritten release with the same version number must reinstall its installer once; subsequent manager updates use the new channel. Qingyi unpacked-extension updates still replace the existing `extension` directory and reload the same extension, preserving its manifest key and browser data. Do not load a second copy under a different directory.
