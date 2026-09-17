# Findings — Sol UX Optimization Run

Start: 2026-09-17 08:08 · Branch: `ux-optimization-run`  
Worker mode: parallel · Final tests: `npm test` → 16/16

Legend: FIXED / DEFERRED / REJECTED · Source: checklist | Worker A/B | [חקירה עצמאית]

---

### F01 Empty send silent → FIXED `b5335a6`
[FEEDBACK] toast «כתוב הודעה או צרף תמונה» · Test: ux-composer-a11y · Source: Worker A

### F02 Queue send aria-label → FIXED `b5335a6`
[ACCESSIBILITY] syncSendAffordance sets aria-label · Source: Worker A

### F03 Stop 40→44px → FIXED `b5335a6`
[RESPONSIVENESS] coarse .stop · Source: Worker A

### F04 Dict strip touch → FIXED `b5335a6`
[RESPONSIVENESS] .dk-lang/.dk-stop 40px · Source: Worker A

### F05 Queue remove 22→36 → FIXED `b5335a6`
[RESPONSIVENESS] .q-rm · Source: Worker A

### F06 Mic http disabled silent → FIXED `b5335a6`
[FEEDBACK] aria-disabled + toast · Source: Worker A

### F07 Dark «תמיד» 2.07:1 → FIXED `b5335a6`
[ACCESSIBILITY] MEASURED after **8.23:1** via --on-accent · Source: Worker B [חקירה עצמאית]

### F08 --surface undefined → FIXED `b5335a6`
[VISUAL] → --panel · Source: Worker B [חקירה עצמאית]

### F09 Copy code keyboard → FIXED `b5335a6`
[ACCESSIBILITY] :focus-within · Source: Worker B

### F10 askBar aria-live → FIXED `b5335a6`
[ACCESSIBILITY] · Source: Worker B

### F11 Stop far from composer → DEFERRED
[DISCOVERABILITY] Structural · Source: Worker A

### F12 Pills hidden in compose-compact → DEFERRED
[FRICTION] Intentional keyboard layout · Source: Worker A

### F13 Transcript full rebuild → DEFERRED
[PERFORMANCE] High risk · Source: Worker B

### F14 Markdown every delta → DEFERRED
[PERFORMANCE] · Source: Worker B

### F15 #log aria-live flood → DEFERRED
[ACCESSIBILITY] Needs SR redesign · Source: Worker B

### F16 statusPill «מוכן» when disconnected → FIXED `b5335a6`
[FEEDBACK] setStatus drives pill · Source: [חקירה עצמאית]

### F17 Mid-busy conv switch ghost → FIXED `b5335a6`
[CONFUSION] toast with owner title + queue count · Source: [חקירה עצמאית]

### F18 Jump 38px / no aria-label → FIXED `b5335a6`
[RESPONSIVENESS] 44px + aria-label · Source: [חקירה עצמאית]

### F19 GOD hint hover-only → FIXED `b5335a6`
[DISCOVERABILITY] select.title = GOD_HINT · Source: [חקירה עצמאית]

### F20 Notify chip icon-only → FIXED `b5335a6`
[ACCESSIBILITY] aria-label · Source: [חקירה עצמאית]

### F21 Long title unbounded → FIXED `b5335a6`
[RESPONSIVENESS] rename clamp 80 · Source: checklist-adjacent [חקירה עצמאית]

### F22 Limit bar cleared on switch → FIXED `b5335a6`
[FEEDBACK] toast when clearing · Source: [חקירה עצמאית]

### F23 Escape palette/settings → FIXED `b3632ac`
[RECOVERY] global Escape · Source: [חקירה עצמאית]

### F24 Secondary device silent → FIXED `b3632ac`
[CONFUSION] «תצוגה בלבד» · Source: [חקירה עצמאית]

### F25 Attachment err no retry → FIXED `b3632ac`
[RECOVERY] uploadAttachment + click retry · Source: [חקירה עצמאית]

### F26 Theme no feedback → FIXED `b3632ac`
[FEEDBACK] toast + aria-label · Source: [חקירה עצמאית]

### F27 ab-go/lb-go 38px → FIXED `b3632ac`
[RESPONSIVENESS] 44px · Source: checklist

### F28 Find cleared on render → FIXED `0b9962e`
[RECOVERY] restore findQ · Source: Worker B [חקירה עצמאית]

### F29 Working overwrites permWaiting → FIXED `0b9962e`
[CONFUSION] pendingPerms first · Source: [חקירה עצמאית]

### F30 Queue strip no live → FIXED `0b9962e`
[ACCESSIBILITY] aria-live · Source: [חקירה עצמאית]

### F31 Keyboard force stick → FIXED `0b9962e`
[FRICTION] autoScroll() without force · Source: [חקירה עצמאית]

### F32 text-faint on panel-2 4.37 → FIXED `0b9962e`
[ACCESSIBILITY] MEASURED after **4.64:1** · Source: [חקירה עצמאית]

### F33 Drawer backdrop hidden attr → FIXED `0d3854a`
[RECOVERY] remove HTML hidden · Source: [חקירה עצמאית]

### F34 Model picker aria → FIXED `0d3854a`
[ACCESSIBILITY] haspopup/expanded · Source: [חקירה עצמאית]

### F35 moreBtn discoverability → FIXED `0d3854a`
[DISCOVERABILITY] richer label + expanded · Source: [חקירה עצמאית]

### F36 Save error silent → FIXED `0d3854a`
[FEEDBACK] toast on error · Source: [חקירה עצמאית]

### F37 Dropzone no Escape → FIXED `82af9c8`
[RECOVERY] hideDropzone · Source: [חקירה עצמאית]

### F38 Stale + «חושב…» → FIXED `82af9c8`
[CONFUSION] «נראה תקוע» · Source: [חקירה עצמאית]

### F39 Statusbar overflow mobile → FIXED `82af9c8`
[RESPONSIVENESS] #sbContext ellipsis · Source: [חקירה עצמאית]

### F40 AC no scrollIntoView → FIXED `82af9c8`
[FRICTION] · Source: [חקירה עצמאית]

### F41 Viewport matrix untested → FIXED `2fbb65c`
[RESPONSIVENESS] ux-viewport-matrix.test.mjs · Source: simulation

### F42 Palette Ctrl+K on phone → FIXED `2fbb65c`
[DISCOVERABILITY] isTouch placeholder · Source: [חקירה עצמאית]

### F43 Stop when disconnected silent → FIXED `4542bda`
[FEEDBACK] toast + manualCheck · Source: [חקירה עצמאית]

### F44 .resync undersized → FIXED `4542bda`
[RESPONSIVENESS] 44px · Source: [חקירה עצמאית]

### F45 Halt no one-click continue → FIXED (Round 2)
[RECOVERY] «נסה שוב» restores last prompt · Source: [חקירה עצמאית] · was DEFERRED

### F46 #log streaming SR → DEFERRED (F15)
### F47 Pills in compact → DEFERRED (F12)
### F48 Stop in composer → DEFERRED (F11)

### F49 Anon × delete without confirm → FIXED (Round 2)
[RECOVERY] deleteConv → leaveAnon/anonLeaveOk · Source: [חקירה עצמאית]

### F50 renderConversation force-scroll when reading history → FIXED (Round 2)
[FRICTION] preserveScroll when !stick · Source: [חקירה עצמאית]

### F51 Switch conv inherits prior stick=false → FIXED (Round 2)
[FRICTION] stick=true on switchConv · Source: [חקירה עצמאית]

### F52 Leaving running duet silent → FIXED (Round 2)
[FEEDBACK] toast «הדואט ממשיך ברקע» · Source: [חקירה עצמאית]

### F53 Duet export nearly empty → FIXED (Round 2)
[FEEDBACK] exportActiveConv uses duetShownText · Source: [חקירה עצמאית]

### F54 Remote draft conflict silent → FIXED (Round 2)
[FEEDBACK] toast · Source: [חקירה עצמאית]

### F55 Usage modal focus trap exit → FIXED (Round 2)
[ACCESSIBILITY] _returnFocus · Source: [חקירה עצמאית]

### F56 AC @/ empty or error silent → FIXED (Round 2)
[FEEDBACK] ac-empty + getCommands {ok} · Source: [חקירה עצמאית]

### F57 Paste image null-file silent → FIXED (Round 2)
[FEEDBACK] toast · Source: [חקירה עצמאית]

### F58 Upload fail no toast → FIXED (Round 2)
[FEEDBACK] toast on catch · Source: [חקירה עצמאית]

### F59 GOD mode selected silent → FIXED (Round 2)
[DISCOVERABILITY] toast on perm=god · Source: [חקירה עצמאית]

### F60 cmdCache=[] treated as miss → FIXED (Round 2)
[FRICTION] cmdCache !== null · Source: [חקירה עצמאית]
