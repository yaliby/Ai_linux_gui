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

### F61 limitCancel offline silent → FIXED (Round 3)
[FEEDBACK] toast «אין חיבור לשרת» · Source: [חקירה עצמאית]

### F62 clearQueue / queue_remove offline → FIXED (Round 3)
[FEEDBACK] no optimistic clear; toast · Source: [חקירה עצמאית]

### F63 toasts not announced to SR → FIXED (Round 3)
[ACCESSIBILITY] #toasts aria-live polite · Source: [חקירה עצמאית]

### F64 share intake fail silent → FIXED (Round 3)
[FEEDBACK] toast on catch · Source: [חקירה עצמאית]

### F65 checkCwd network fail silent → FIXED (Round 3)
[FEEDBACK] hint bad text · Source: [חקירה עצמאית]

### F66 Claude rewind no confirm → FIXED (Round 3)
[RECOVERY] confirm before fork/slice · Source: [חקירה עצמאית]

### F67 empty export silent success → FIXED (Round 3)
[FEEDBACK] toast when empty / no duet body · Source: [חקירה עצמאית]

### F68 ArrowUp overwrites draft → FIXED (Round 4)
[FRICTION] hist only when empty or mid-browse · Source: [חקירה עצמאית]

### F69 Settings Escape drops focus → FIXED (Round 4)
[ACCESSIBILITY] closeSettings + returnFocus · Source: [חקירה עצמאית]

### F70 Offline permission closes card locally → FIXED (Round 4)
[RECOVERY] decidePermission/sendDialog require WS · Source: [חקירה עצמאית]

### F71 Duet empty note/save silent → FIXED (Round 5)
[FEEDBACK] toasts · Source: [חקירה עצמאית]

### F72 Duet version fetch fail silent → FIXED (Round 5)
[FEEDBACK] toast · Source: [חקירה עצמאית]

### F73 Conv body search fail silent → FIXED (Round 6)
[FEEDBACK] toast · Source: [חקירה עצמאית]

### F74 icon-btn / cwd-chip undersized on coarse → FIXED (Round 6)
[RESPONSIVENESS] 44px · Source: [חקירה עצמאית]

### F75 Rename only via dblclick — broken on touch → FIXED (Round 7)
[DISCOVERABILITY] long-press + convTitle click + palette · Source: [חקירה עצמאית]

### F76 notify/anon/duet/tool-rej touch undersized → FIXED (Round 8)
[RESPONSIVENESS] 44px coarse · Source: Worker A/B

### F77 findCount not live → FIXED (Round 8)
[ACCESSIBILITY] aria-live · Source: Worker A

### F78 settings dialog semantics + focus in → FIXED (Round 8)
[ACCESSIBILITY] role=dialog, aria-expanded, focus first · Source: Worker A/B

### F79 model picker / drawer Escape focus → FIXED (Round 8)
[ACCESSIBILITY] closeModelPicker focus; Escape closes drawer · Source: Worker B

### F80 pair-code not a button → FIXED (Round 8)
[ACCESSIBILITY] `<button class=pair-code>` · Source: Worker A

### F81 histIdx stuck after edit → FIXED (Round 8)
[FRICTION] reset on input · Source: Worker B

### F82 duet copy empty says «נכשל» → FIXED (Round 8)
[CONFUSION] toast «אין תוצר» · Source: Worker duet

### F83 duet stopping not painted → FIXED (Round 8)
[FEEDBACK] stopping label + spinner · Source: Worker duet

### F84 anon tools aria-pressed → FIXED (Round 8)
[ACCESSIBILITY] · Source: Worker B

### F85 cwdChip aria-label when icon-only → FIXED (Round 8)
[ACCESSIBILITY] · Source: Worker B

### F86 Wake lock not re-acquired after OS release → FIXED (Round 9)
[FEEDBACK] re-request on release · Source: Worker B

### F87 Pair expiry countdown stale → FIXED (Round 9)
[CONFUSION] 15s tick while modal open · Source: Worker A

### F88 Landscape viewport untested → FIXED (Round 9)
[RESPONSIVENESS] 844×390 in ux-viewport-matrix · Source: simulation

### F89 toast.err not assertive → FIXED (Round 10)
[ACCESSIBILITY] role=alert · Source: Worker B

### F90 compact hides hot context → FIXED (Round 10)
[FEEDBACK] statusbar.has-hot stays visible · Source: Worker B

### F91 Enter queues while ask pending → FIXED (Round 10)
[FRICTION] toast + jumpToPendingAsk · Source: Worker B

### F92 loadConfig fail silent → FIXED (Round 11)
[FEEDBACK] toast · Source: [חקירה עצמאית]

### F93 sideBackdrop skips closeDrawer focus → FIXED (Round 11)
[ACCESSIBILITY] uses closeDrawer() · Source: [חקירה עצמאית]

### F94 Duet maxTurns unclamped → FIXED (Round 12)
[FRICTION] clamp 2–30 + aria-live err · Source: Worker B

### F95 Rename missing from shortcuts help → FIXED (Round 12)
[DISCOVERABILITY] SHORTCUTS row · Source: [חקירה עצמאית]

### F96 Generic modal drops focus → FIXED (Round 13)
[ACCESSIBILITY] modalReturnFocus + role=dialog · Source: [חקירה עצמאית]

### F97 Delete conv no confirm → FIXED (Round 14)
[RECOVERY] confirm before DELETE · Source: Worker Round 14

### F98 New chat aborts turn silently → FIXED (Round 14)
[FEEDBACK] confirm when busy on active · Source: Worker Round 14

### F99 Re-enter duet shows setup too soon → FIXED (Round 14)
[CONFUSION] _awaitDuetSync loading · Source: Worker Round 14

### F100 Empty share intake silent → FIXED (Round 14)
[FEEDBACK] toast · Source: Worker Round 14

### F101 Logs copy skips legacyCopy → FIXED (Round 14)
[FEEDBACK] uses copyText() · Source: Worker Round 14

### F102 PWA ?go=new bypasses startNewChat → FIXED (Round 15)
[RECOVERY] runLaunchShortcut → startNewChat · Source: Worker Round 15

### F103 resumeSession skips switchConv → FIXED (Round 15)
[FRICTION] uses switchConv pipeline · Source: Worker Round 15

### F104 Logs copy while loading → FIXED (Round 15)
[FEEDBACK] guard placeholder/error · Source: Worker Round 15

### F105 Palette Escape focus trap → FIXED (Round 15)
[ACCESSIBILITY] paletteReturnFocus · Source: Worker Round 15

### F106 Delete DELETE fail silent → FIXED (Round 15)
[FEEDBACK] toast on failed DELETE · Source: Worker Round 15

### F107 deleteConv skips restoreDraft/subscribeActive → FIXED (Round 16)
[FRICTION] stick + restoreDraft + syncConvCwd + renderQueue · Source: Worker Round 16

### F108 onRemoteConvDeleted draft gap → FIXED (Round 16)
[FRICTION] parity with local delete · Source: Worker Round 16

### F109 Palette settings/find under drawer → FIXED (Round 16)
[CONFUSION] closeDrawer before open · Source: Worker Round 16

### F110 closeFind duet focuses hidden input → FIXED (Round 16)
[ACCESSIBILITY] focus findBtn/moreBtn · Source: Worker Round 16

### F111 Offline send blocks queue-while-busy → FIXED (Round 17)
[FEEDBACK] clearer toast when busy/limit offline · Source: Worker A Round 16b

### F112 askBar jump takes first perm not AskUserQuestion → FIXED (Round 17)
[CONFUSION] prefer AskUserQuestion in jumpToPendingAsk · Source: Worker A Round 16b

### F113 Enter sends while @ autocomplete still loading → FIXED (Round 17)
[FRICTION] capture handler swallows Enter while ac open · Source: Worker A Round 16b

### F114 Notification tap no jumpToPendingAsk → FIXED (Round 17)
[DISCOVERABILITY] notification-click + direct onclick · Source: Worker A Round 16b

### F115 fileFetch race overwrites newer query → FIXED (Round 17)
[FRICTION] ac.token.q === q guard · Source: Worker A Round 16b

### F116 Shortcuts modal Tab escapes → FIXED (Round 18)
[ACCESSIBILITY] onModalKeydown Tab trap · Source: Worker A Round 16b

### F117 Enter ignores pending tool permissions → FIXED (Round 17)
[FRICTION] pendingPerms.size gate · Source: Worker B Round 16

### F118 switchConv while busy → abandonTurn on idle sync → FIXED (Round 17)
[RECOVERY] abandon only if streamOwnerId === subId · Source: Worker B Round 16

### F119 Active anon × leaveAnon keepActive leaves null → FIXED (Round 17)
[RECOVERY] restore sibling after leaveAnon · Source: Worker B Round 16

### F120 Send button bypasses pending-ask gate → FIXED (Round 18)
[FRICTION] sendMessage early return · Source: Worker Round 18

### F121 Reconnect leaves stale ask cards → FIXED (Round 18)
[RECOVERY] closePermission for ids absent from sync · Source: Worker Round 18

### F122 Limit-bar countdown stale → FIXED (Round 18)
[FEEDBACK] 1s ticker + seconds under 1min · Source: Worker Round 18

### F123 Ctrl+F opens find under palette → FIXED (Round 18)
[CONFUSION] closePalette before openFind · Source: Worker Round 18

### F124 Share non-image silent drop → FIXED (Round 18)
[FEEDBACK] toast images-only · Source: Worker Round 18

### F125 Escape closes wrong visual layer → FIXED (Round 18)
[CONFUSION] z-order Escape stack · Source: Worker Round 18 Escape

### F126 Usage modal Tab escapes → FIXED (Round 19)
[ACCESSIBILITY] onUsageModalKeydown trap · Source: Worker Round 19

### F127 Rewind clears queue silently → FIXED (Round 19)
[CONFUSION] toast with queued count · Source: Worker Round 19

### F128 Cwd picker pick after failed nav → FIXED (Round 19)
[FEEDBACK] disable pick on loadDirs error · Source: Worker Round 19

### F129 Pair actions live after expiry → FIXED (Round 19)
[FEEDBACK] disable code/copy + fade QR · Source: Worker Round 19

### F130 Mermaid no copy button → FIXED (Round 20)
[FRICTION] copy-btn on mermaid-wrap · Source: Worker Round 20

### F131 Model picker ★ mouse-only → FIXED (Round 20)
[ACCESSIBILITY] click + F key · Source: Worker Round 20

### F132 Theme toggle skips mermaid → FIXED (Round 20)
[CONFUSION] rethemeMermaid · Source: Worker Round 20

### F133 Halt retry wrong in anon → FIXED (Round 20)
[RECOVERY] last user msg from conv · Source: Worker Round 20

### F134 Double send queues duplicate → FIXED (Round 21)
[RACE] sendGate + Enter !repeat · Source: Worker Round 21

### F135 workingText no aria-live → FIXED (Round 21)
[ACCESSIBILITY] #working role=status aria-live · Source: Worker Round 21

### F136 q-rm shrinks to 30px on mobile → FIXED (Round 22)
[RESPONSIVENESS] keep 36px; was coarse regression · Source: Worker Round 22 CSS

### F137 lb-go shrinks to 40px on mobile → FIXED (Round 22)
[RESPONSIVENESS] keep min-height 44px · Source: Worker Round 22 CSS

### F138 findInput outline:none no substitute → FIXED (Round 22)
[ACCESSIBILITY] inset accent box-shadow on focus · Source: Worker Round 22 CSS

### F139 Secondary presence looks like primary on narrow → FIXED (Round 23)
[CONFUSION] data-mode=view → 👁N · Source: Worker Round 23

### F140 Notification allow/deny fail silent offline → FIXED (Round 23)
[RECOVERY] showNotification on answerAsk catch · Source: Worker Round 23

### F141 Dict lang switch keeps stale interim → FIXED (Round 23)
[CONFUSION] clear interim + dictRender · Source: Worker Round 23

### F142 OS theme change skips mermaid → FIXED (Round 24)
[CONFUSION] rethemeMermaid on prefers-color-scheme · Source: regression dig

### F143 Sync revive spams N toasts → FIXED (Round 24)
[FEEDBACK] silent showPermission + one toast · Source: regression dig

### F144 Modal re-open stacks keydown listeners → FIXED (Round 25)
[RECOVERY] removeEventListener before add · Source: Worker Round 25

### F145 newAnon.disabled blocks toast (pointer-events) → FIXED (Round 25)
[FEEDBACK] cursor:not-allowed; click still toasts · Source: Worker Round 25

### F146 Rename Escape closes drawer on mobile → FIXED (Round 26)
[CONFUSION] stopPropagation on Escape in startRename · Source: Worker Round 26
