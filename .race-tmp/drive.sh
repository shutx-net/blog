#!/usr/bin/env bash
set -u
R=/home/shutx/github/blog/.race-tmp
MS=${1:-4000}; TRIALS=${2:-5}
hit=0
for t in $(seq 1 "$TRIALS"); do
  rm -f "$R/out/index.mjs"
  node "$R/builder.ts" "$R" "$MS" >/dev/null 2>&1 & b1=$!
  node "$R/builder.ts" "$R" "$MS" >/dev/null 2>&1 & b2=$!
  node "$R/hasher.ts"  "$R" "$MS" > "$R/h.json" 2>"$R/h.err" & h=$!
  wait $b1 $b2 $h
  loops=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$R/h.json','utf8')).loops)}catch(e){console.log(-1)}")
  cnt=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$R/h.json','utf8')).count)}catch(e){console.log(-1)}")
  if [ "$loops" -le 0 ]; then
    echo "  試行 $t: ★ハーネスが動いていない（loops=$loops）"; head -c 200 "$R/h.err"; echo
    continue
  fi
  if [ "$cnt" -gt 0 ]; then
    hit=$((hit+1))
    echo "  試行 $t: 再現（$loops 周中 $cnt 件）"
    node -e "console.log('      '+JSON.parse(require('fs').readFileSync('$R/h.json','utf8')).sample[0])"
  else
    echo "  試行 $t: 再現せず（$loops 周）"
  fi
done
echo "再現: $hit / $TRIALS 試行"
