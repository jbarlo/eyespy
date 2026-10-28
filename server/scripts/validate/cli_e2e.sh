#!/usr/bin/env bash
# CLI end to end over tRPC: most commands, auto-start, -C, headless -i, config flags, --json, frame folders.
# Run it in the devshell. eyespy reads only folders of frames, so ffmpeg extracts every frame of each video first, and
# the script adds each folder at the video's frame rate. It adds the second video and then removes it.
set -u
[ $# -eq 3 ] || { echo "usage: cli_e2e.sh <workdir> <video> <second-video>" >&2; exit 2; }
W=$1 VIDEO=$2 VIDEO2=$3
NAME=$(basename "${VIDEO%.*}") NAME2=$(basename "${VIDEO2%.*}")
frames() { # frames <video> <dir>: extract every frame of the video once
  [ -d "$2" ] && return
  rm -rf "$2.tmp" && mkdir -p "$2.tmp" && ffmpeg -v error -i "$1" -fps_mode passthrough -q:v 2 "$2.tmp/%06d.jpg" && mv "$2.tmp" "$2"
}
rate() { # rate <video>: its average frame rate, as a decimal
  ffprobe -v error -select_streams v:0 -show_entries stream=avg_frame_rate -of csv=p=0 "$1" | awk -F/ '{ print $1 / ($2 ? $2 : 1) }'
}
FR=$W/frames/$NAME
SECOND=$W/frames/$NAME2
frames "$VIDEO" "$FR" || { echo "frame extraction failed"; exit 1; }
frames "$VIDEO2" "$SECOND" || { echo "frame extraction failed"; exit 1; }
FPS=$(rate "$VIDEO") FPS2=$(rate "$VIDEO2")
PHOTOS=$W/frames/photos # four frames of the clip as a folder of photos (no --fps: every one a keyframe)
rm -rf "$PHOTOS" && mkdir -p "$PHOTOS" && for n in 000001 000240 000480 000720; do cp "$FR/$n.jpg" "$PHOTOS/IMG_$n.jpg"; done
NOTFRAMES=$W/frames/not-frames
rm -rf "$NOTFRAMES" && mkdir -p "$NOTFRAMES" && cp "$FR/000001.jpg" "$NOTFRAMES/" && echo notes >"$NOTFRAMES/notes.txt"
echo "frames: $(ls "$FR" | wc -l) of $NAME at $FPS fps, $(ls "$SECOND" | wc -l) of $NAME2 at $FPS2 fps"
S=$W/e2e
export XDG_CACHE_HOME=$W/xdg # headless sessions land here, not in ~/.cache
rm -rf "$S" "$XDG_CACHE_HOME"
pass=0 fail=0
run() { # run <expect: ok|err> <args...>
  local expect=$1; shift
  local t0=$(date +%s%N)
  out=$(eyespy "$@" 2>&1); code=$?
  local ms=$(( ($(date +%s%N) - t0) / 1000000 )); local dt=$((ms / 1000)).$(( (ms % 1000) / 100 ))
  if { [ "$expect" = ok ] && [ $code -eq 0 ]; } || { [ "$expect" = err ] && [ $code -ne 0 ]; }; then
    pass=$((pass + 1)); st=PASS
  else
    fail=$((fail + 1)); st=FAIL
  fi
  printf '%s %5ss  eyespy %s\n' "$st" "$dt" "$*"
  printf '%s\n' "$out" | head -n "${LINES_SHOWN:-4}" | sed 's/^/      /'
}
first_id() { eyespy -C "$S" --json dets -f "$1" -p "$2" | jq -r ".hits[${3:-0}].id"; }

run ok init "$S" -a "$FR" --fps $FPS               # auto-starts the server, picks keyframes
run ok -C "$S" status
cd "$S"
run ok status --json
run ok config
run ok config threshold 0.55
run ok config threshold
run ok config threshold 0.5
run err config nonsense 1
run ok sheet -f 0-11
run ok find jar -f 0-3
run ok find jar -f 0-3 -c -t 0.7
run ok --presence 0.99 find jar -f 0-3                 # per-call override of a setting
run ok --score-floor 0.4 find bottle -f 0-3
run err --bogus 1 find jar -f 0
run ok semantic jar -f 0-2
run ok dets -f 0 -p jar
run ok dets -f 0-1 -c
A=$(first_id 0-3 jar 0); B=$(first_id 0-3 jar 9); C=$(first_id 0-3 jar 10); D=$(first_id 0-3 jar 17); E=$(first_id 0-3 bottle 0); F=$(first_id 0-3 bottle 1)
echo "ids: A=$A B=$B C=$C D=$D E=$E F=$F"
run ok crop "$A"
run ok similar "$A" -k 3
run ok obj new "glass jar" "$A" "$B"
run ok obj add o1 "$C"
run ok obj new "second jar" "$D"
run ok obj label o2 "второй jar (café)"                # non-ASCII label, rendered via SVG text
run ok obj merge o1 o2
run ok obj new "tmp" "$C"                               # o3: ids are never reused (o2 was merged away)
run err obj show o2
run ok obj remove o3 "$C"
run ok obj delete o3
run err obj delete x
run err obj show o99
run ok obj show o1
run ok obj suggest o1 -k 4
run ok reject "$E"
run ok reject -p bottle "$F"
run ok show -f 0-3
run ok show -f 0-3 -o
run ok show -r -f 0-3
run ok show -c -f 0
run ok semantic jar -f 0-2 -u
run ok todo
run ok todo -n 5 -c
run ok todo -g
run ok gaps -f 0-3
run ok manifest
run ok manifest -c
run ok --json manifest
run ok clips
run err add "$VIDEO"                                    # a video file: eyespy takes frames
run err add "$NOTFRAMES" --fps $FPS                     # a stray file in the folder
run err add "$S/nope"
run ok add "$SECOND" --fps $FPS2                         # a second clip, then remove it (tombstone)
H0=$(eyespy --json clips | jq '.clips[-1].frames[0]')
run ok find jar -f "$H0"
run ok clips
run ok clips rm "$NAME2"
run err clips rm "$NAME2"
run ok clips -a
run err sheet -f "$H0"                                  # its keyframe is hidden now
run ok add "$SECOND" --fps 10                            # revived at its first rate (same numbers)
run ok add "$PHOTOS"                                     # photos: every one a keyframe, tagged "photo n"
P0=$(eyespy --json clips | jq '.clips[-1].frames[0]')
run ok sheet -f "$P0-$((P0 + 3))"
run ok clips
run ok export "$W/export.json"
run ok stop
run ok status                                           # auto-starts again
run ok stop
run ok --idle-minutes 1 status
test -S .eyespy/sock && echo "      (server up, waiting for idle exit)"
sleep 100
if [ -S .eyespy/sock ]; then fail=$((fail + 1)); echo "FAIL  idle exit (socket still there)"; else pass=$((pass + 1)); echo "PASS  idle exit after 1 min"; tail -2 .eyespy/server.log | sed 's/^/      /'; fi
LINES_SHOWN=6 run ok -i "$FR" --fps $FPS status          # headless: session cached under $XDG_CACHE_HOME
run ok -i "$FR" --fps $FPS find jar -f 0
run err -i "$VIDEO" status                               # refused before a server starts
H=$(find "$XDG_CACHE_HOME/eyespy" -maxdepth 1 -mindepth 1 -type d | head -1)
run ok -C "$H" stop
run ok completions zsh
echo "passed $pass, failed $fail"
