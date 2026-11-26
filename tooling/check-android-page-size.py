#!/usr/bin/env python3
"""Verify the APK ZIP and 64-bit ELF load segments for 16 KiB alignment."""

import argparse
from pathlib import Path
import struct
import subprocess
from zipfile import BadZipFile, ZipFile


PAGE_SIZE = 16 * 1024
ANDROID_ABIS = {"arm64-v8a", "x86_64"}
ELF_HEADER_SIZE = 64
ELF_PROGRAM_HEADER = struct.Struct("<IIQQQQQQ")
PT_LOAD = 1


def check_elf(library, library_size):
    header = library.read(ELF_HEADER_SIZE)
    if len(header) != ELF_HEADER_SIZE or not header.startswith(b"\x7fELF\x02\x01"):
        raise ValueError("expected a little-endian ELF64 header")

    table_offset = struct.unpack_from("<Q", header, 32)[0]
    entry_size, entry_count = struct.unpack_from("<HH", header, 54)
    if (table_offset < ELF_HEADER_SIZE or entry_size != ELF_PROGRAM_HEADER.size
            or table_offset + entry_count * entry_size > library_size):
        raise ValueError("invalid ELF program header table")

    library.seek(table_offset)
    load_segments = 0
    for index in range(entry_count):
        segment = ELF_PROGRAM_HEADER.unpack(library.read(entry_size))
        segment_type, _, offset, address, _, _, _, alignment = segment
        if segment_type == PT_LOAD:
            load_segments += 1
            if alignment < PAGE_SIZE or (offset - address) % PAGE_SIZE:
                raise ValueError(f"PT_LOAD {index} cannot be mapped at 16 KiB (p_align={alignment})")
    if not load_segments:
        raise ValueError("missing PT_LOAD segments")


def check_apk(apk):
    counts = {}
    with ZipFile(apk) as archive:
        for entry in archive.infolist():
            parts = entry.filename.split("/")
            if len(parts) != 3 or parts[0] != "lib" or parts[1] not in ANDROID_ABIS or not parts[2].endswith(".so"):
                continue
            try:
                with archive.open(entry) as library:
                    check_elf(library, entry.file_size)
            except (ValueError, struct.error) as error:
                raise ValueError(f"{entry.filename}: {error}") from error
            abi = parts[1]
            counts[abi] = counts.get(abi, 0) + 1
    if not counts:
        raise ValueError("no ARM64 or x86_64 native libraries found")
    return ", ".join(f"{abi}: {count}" for abi, count in sorted(counts.items()))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("apk", type=Path)
    parser.add_argument("--zipalign", required=True, help="Path to the Android SDK build-tools zipalign executable")
    args = parser.parse_args()
    try:
        subprocess.run([args.zipalign, "-c", "-P", "16", "4", str(args.apk.resolve())], check=True)
        libraries = check_apk(args.apk)
    except subprocess.CalledProcessError as error:
        raise SystemExit(f"zipalign rejected {args.apk} (exit {error.returncode}). Run zipalign -c -P 16 -v 4 for details.")
    except (OSError, BadZipFile, ValueError) as error:
        raise SystemExit(f"Cannot verify {args.apk}: {error}")
    print(f"16 KiB ZIP and ELF alignment verified ({libraries} native libraries).")


if __name__ == "__main__":
    main()
