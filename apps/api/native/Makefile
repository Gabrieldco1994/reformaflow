SHELL := /bin/sh
.SHELLFLAGS := -eu -c
.ONESHELL:
CC := cc
CFLAGS := -std=c11 -O2 -g -Wall -Wextra -Werror -Wformat=2 -fstack-protector-strong -D_FORTIFY_SOURCE=2 -fPIE
LDFLAGS := -Wl,-z,relro,-z,now -pie
OUT := $(CURDIR)/build
IMAGE_ROOT ?=
STAGE ?= $(OUT)/runtime
export IMAGE_ROOT STAGE

.PHONY: build stage inspect
build:
	test "$$(uname -s)" = Linux || { echo "X2 requires an authorized Linux build host" >&2; exit 1; }
	test "$$(uname -m)" = x86_64 || { echo "Only the initial amd64 profile is declared" >&2; exit 1; }
	test -f /usr/include/seccomp.h || { echo "Missing libseccomp-dev; installation is not automatic" >&2; exit 1; }
	mkdir -p "$(OUT)"
	$(CC) $(CFLAGS) x2-launcher.c $(LDFLAGS) -lseccomp -o "$(OUT)/reformaflow-x2"

inspect: build
	readelf --file-header --program-headers --dynamic "$(OUT)/reformaflow-x2"
	sha256sum "$(OUT)/reformaflow-x2"

# Run only against an explicitly selected image filesystem, never a developer tree.
stage:
	test -n "$(IMAGE_ROOT)" && test -d "$(IMAGE_ROOT)"
	test ! -e "$(STAGE)"
	test "$$(id -u)" = 0 || { echo "Closure ownership requires authorized root packaging" >&2; exit 1; }
	command -v python3 >/dev/null
	command -v readelf >/dev/null
	python3 - <<'PY'
	import hashlib, json, os, pathlib, re, shutil, subprocess
	image = pathlib.Path(os.environ["IMAGE_ROOT"]).resolve(strict=True)
	stage = pathlib.Path(os.environ["STAGE"]).absolute()
	if image == pathlib.Path("/") or stage == pathlib.Path("/"):
	    raise SystemExit("Explicit separate image and output roots required")
	stage.mkdir(mode=0o755)
	copied = {}
	elf_queue = []
	def source_path(absolute):
	    if not absolute.startswith("/") or ".." in pathlib.PurePosixPath(absolute).parts:
	        raise SystemExit("Invalid image path: " + absolute)
	    candidate = image / absolute.lstrip("/")
	    for _ in range(32):
	        if not candidate.is_symlink():
	            break
	        link = os.readlink(candidate)
	        candidate = image / link.lstrip("/") if link.startswith("/") else candidate.parent / link
	    resolved = candidate.resolve(strict=True)
	    if not resolved.is_relative_to(image) or not resolved.is_file():
	        raise SystemExit("Source escapes image or is not regular: " + absolute)
	    return resolved
	def install(source, destination, mode):
	    if not destination.startswith("/") or ".." in pathlib.PurePosixPath(destination).parts:
	        raise SystemExit("Invalid destination")
	    origin = source_path(source)
	    if destination in copied:
	        if copied[destination] != origin:
	            raise SystemExit("Conflicting destination: " + destination)
	        return
	    target = stage / destination.lstrip("/")
	    target.parent.mkdir(parents=True, exist_ok=True)
	    shutil.copyfile(origin, target)
	    target.chmod(mode)
	    copied[destination] = origin
	    with target.open("rb") as f:
	        if f.read(4) == b"\x7fELF":
	            elf_queue.append((source, target))
	for line in pathlib.Path("x2-runtime-files.txt").read_text().splitlines():
	    if not line or line.startswith("#"):
	        continue
	    source, destination, mode = line.split()
	    install(source, destination, int(mode, 8))
	# No execution of node, a .node module, ldd, the launcher, or any parser.
	for source, target in elf_queue:
	    header = subprocess.check_output(["readelf", "-h", str(target)], text=True)
	    if "Advanced Micro Devices X86-64" not in header:
	        raise SystemExit("ELF architecture outside initial amd64 profile: " + source)
	    program = subprocess.check_output(["readelf", "-l", str(target)], text=True)
	    interpreter = re.search(r"Requesting program interpreter: ([^\]]+)", program)
	    if interpreter:
	        loader = interpreter.group(1)
	        install(loader, loader, 0o555)
	    dynamic = subprocess.check_output(["readelf", "-d", str(target)], text=True)
	    if re.search(r"\((RPATH|RUNPATH)\)", dynamic):
	        raise SystemExit("ELF search path requires explicit qualification: " + source)
	    for name in re.findall(r"\(NEEDED\).*?\[([^\]]+)\]", dynamic):
	        if "/" in name:
	            raise SystemExit("Unexpected NEEDED path")
	        candidates = ["/lib/x86_64-linux-gnu/" + name, "/usr/lib/x86_64-linux-gnu/" + name,
	                      "/lib64/" + name, "/usr/local/lib/" + name]
	        found = next((p for p in candidates if (image / p.lstrip("/")).exists()), None)
	        if found is None:
	            raise SystemExit("Missing image DSO: " + name)
	        install(found, found, 0o555)
	for name in (".old", "dev"):
	    (stage / name).mkdir(exist_ok=True)
	lines = []
	for destination in sorted(copied):
	    digest = hashlib.sha256((stage / destination.lstrip("/")).read_bytes()).hexdigest()
	    lines.append(digest + "  " + destination + "\n")
	manifest = "".join(lines).encode("ascii")
	(stage / ".x2-manifest").write_bytes(manifest)
	(stage / ".x2-seal").write_text(hashlib.sha256(manifest).hexdigest() + "\n", encoding="ascii")
	for path in (stage / ".x2-manifest", stage / ".x2-seal"):
	    path.chmod(0o444)
	for directory, _, _ in os.walk(stage, topdown=False):
	    os.chmod(directory, 0o555)
	print("STATIC CLOSURE ONLY; dlopen/fonts/Node startup and isolation NOT QUALIFIED")
	print("seal=" + hashlib.sha256(manifest).hexdigest())
	PY
