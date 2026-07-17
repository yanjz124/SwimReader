# eATS Computer Commands (text extraction)

> **Source:** `docs/eats-computer-commands.pdf` (eATS simulator manual, 18 June 2025 edition) — a NAS
> Stage A / ERAM-style command reference from the eATS home ATC simulation.
>
> **Authority level:** supplementary. **Less authoritative than `docs/crc-eram-reference.md`** (the
> CRC/vNAS spec, which governs when they disagree), but very good coverage of classic NAS/ERAM CRD
> command formats (FP/AM/QF/QU/QL/QQ/QZ/QP/QD/CO/SR, quick-action keys, field-10 route amendments).
> eATS-specific simulation commands (XX …, ACGEN, WARMUP, etc.) do not apply to real ERAM.
>
> This file is a raw text extraction of the PDF for grep-ability; consult the PDF for tables/layout.
> Notable: eATS documents Quick Look accepting airport IDs (`QL LAX` = FDBs for matching destinations,
> additive up to 5) — the documented cousin of our custom NK arrival-force command.


=== PAGE 1 ===
Computer Commands
Introduction.............................................................................................. 2
Notes on Command T able......................................................................... 3
Command T able........................................................................................ 5
TRACK................................................................................................... 6
FLIGHT DATA......................................................................................... 6
DISPLAY.................................................................................................9
CONTINUOUS RANGE READOUT..........................................................13
FACILITY AND SECTOR.........................................................................15
TRAFFIC...............................................................................................16
MAP.....................................................................................................18
RADAR.................................................................................................19
ENVIRONMENT.................................................................................... 19
POP UP WINDOWS...............................................................................20
SIMULATION CONTROL AND INFORMATION.........................................21
DATABASE CONSISTENCY....................................................................22
CALCULATOR AND MORE.................................................................... 22
Quick Action Keys................................................................................... 24
Keyboard Shortcuts.................................................................................25
Zoom Buttons......................................................................................... 26
Field 10 Route Amendments...................................................................27
18 JUNE 2025 eATS Computer Commands Page  1
=== PAGE 2 ===
Introduction
The design goal is to select elements that will fit on a typical home computer wide screen monitor.  There 
aren't enough square inches to duplicate the multiple displays of the real system.  The "extra" room on the 
side was just about right to hold some old style controls that are still applicable.
You communicate with the ATC Computer via an input/output text window in the style of the CRD, 
Computer Readout Device, of NAS Stage A.  This is the window with the black background at the middle 
right of the screen.  There is only one CRD and therefore no distinction between R-side and D-side CRD 
functions.  Some D-side activity will generate CRD input/output when you are using the radio input/output 
windows.  The only pronounciation I have ever heard for CRD is "crud".
If you start typing with any key except <enter>, the characters go to the CRD input area.  Starting with the 
<enter> key is used to activate the radio to transmit to an airplane.  (A white square indicates the 
transmitter is active.)  If CRD input is in progess, <enter> will terminate most input and start the processing. 
A mouse click on a data block position symbol (diamond or triangle), or on a present position slash, may be 
used to end some commands.  The Range-Bearing function is different, and ends with a mouse click on a 
position of interest.
The <esc> or <escape> key is used to cancel and clear input from the CRD (or the transmitter).  I use 
<esc> a lot to correct mistakes.  Some unusual key sequences require a second <esc> to clear the input.
Most CRD inputs produce a response beginning with ACCEPT or REJECT in the output window.  The data 
is also written to the log file.  It seems better to not echo data block orientation changes because the result 
of the previous action is probably more useful.  However, an existing REJECT message will be cleared to 
prevent confusion.
The input window will be cleared after an ACCEPT message.  Most REJECT messages leave the input so 
you can edit it using standard Windows operations (left arrow, delete, etc.), then hit <enter> again.
The buttons in the lower right corner with the light blue background also make inputs to the computer in the 
style of QAK (Quick Action Keys) and rotary switches of the 1980s, plus a few simulation-specific items.  
Buttons can be clicked with the mouse, and should work if you have a touch sensitive screen.  Some of the 
elements in this panel have keyboard equivalents.  [ add link ] See table at the end of this section.  ERAM 
equipment has similar functions but different details.  It is not terribly difficult to modifiy labels and layout 
(keeping screen space constraints in mind) to make it more up to date.
Standard Windows keyboard function keys may be used for QAKs if shown in white text below the button.  
If the radio transmitter is not active, these keyboard function keys simply enter characters into the CRD 
input window to get a command started (e.g. QP<space>).  Most of the QAKs also display a hint in the 
output window of an expected input format.  The may be additional legal formats as well.
One option for the RNG/BRG (range/bearing) key is no text input, just two left clicks on the points of 
interest.  Another option is RNG/BRG <Fix> <left click>, which gives the great circle range/bearing TO the 
named fix FROM the point clicked.  If the first click of the former, or the only click of the latter, is on a data 
block position symbol, the ETA for a straight line path to the fix at the current displayed ground speed is 
also shown, except for very low ground speeds.  The associated line on the display will disappear after 10 
seconds (no early cancel), or change if you do another range/bearing.
Additional commands to control the simulation, such as selecting a sector, begin with XX and are also 
entered into the CRD input area.  Early versions of the program only had XX commands, and some now 
18 JUNE 2025 eATS Computer Commands Page  2
=== PAGE 3 ===
have menu selections or buttons that are easier to use.  Some functions in the real system use mouse 
actions only, and do not have keyboard equivalents.  Until pop-up windows can be programmed, it may 
make sense to use XX-style commands to perform these functions but give them a more descriptive name, 
such as CRR to handle Continuous Range Readout mouse actions.
A few XX commands have many parameters.  If the desired input is available from another source, a 
normal Windows copy/paste into the CRD input area will work.
If keyboard or mouse clicks do not work as expected, it is likely that input is being sent to a non-obvious 
place.
• A window other than the main program window may be active, which can be fixed by 
clicking within the main window.
• If the mouse cursor is over a Zoom button, Windows considers that button to be 
active and prevents keyboard input from going anywhere useful.  Move the mouse 
cursor off the button.  Clicking on a zoom button will move the cursor off the button 
automatically.
• If CRD input is in progress or the previous input has been retained due to an error, 
function keys and unrelated mouse clicks are ignored, and <enter> will not activate 
the transmitter.  Check for a previous REJECT message and clear with <esc>.
Notes on Command Table
The following is terminology used by the program, and may be different from, or not present in, the real 
system.  Some convenience functions may change if there is a similar real world function that can be 
duplicated.
<FLID> = Flight ID input as text.  For most commands, may use Aircraft ID, computer ID (CID), or discrete 
transponder code.  Aircraft ID must be full call sign. (Abbreviated call sign is a radio option.)
<FLID ♦> = above plus left click on position symbol ♦ or ▲.  A required right click will be stated explicitly.
Details of one command (interim altitude) from the table below: QQ ddd <FLID ♦>.  "ddd" means 3 decimal 
digits, say 350, meaning flight level 350.  If the call sign is N1234X with CID 456, and transponder code 
5361, you could use any of:
QQ 350 N1234X<enter>
QQ 350 456<enter>
QQ 350 5361<enter>
QQ 350(plus left click on ♦ or ▲)
QQ<space> may be typed, or press <F8>, or click on the INT ALT button.
<Sector ID> for handoffs.  For a sector within the active facility - two digits.  For a sector in another facility, 
one letter plus two characters, or just the letter designating the facility (the computer knows ...).  Examples: 
23   L35  S1A  S
18 JUNE 2025 eATS Computer Commands Page  3
=== PAGE 4 ===
Some often used commands, such a accepting a handoff and repositioning a data block, use the "none" 
key, which means a QAK (or two letter command) is not needed.  If extra typing makes you feel good you 
may start these commands with QN (or QZ or <F5>).
Many functions require that you are plugged in.  When you are not plugged in you can do things that do not 
change track or flight plan data, such as displaying flight plan text or a route line.
If you click on a track symbol that is handing off to the active sector and the data block disappears, it 
means you are not plugged in.  This possibly surprising result is consistent with how you get rid of any data 
block that you do not own (and in this case can not own because you are not plugged in).  If no other action 
is taken, the data block will appear when the active sector AI accepts the handoff.
A "not plugged in" response to an input that should be allowed when not plugged in may be a typing error.  
For example repositioning a data block uses one digit for the direction.  If you type two digits, it is 
interpreted as a sector ID and a handoff attempt (which fails if you are not plugged in).
In general, track and flight data commands require that you own the data block.  "/OK" is implemented in a 
few commands to override the normal restrictions.  (More can be added.)  A proper use of /OK is to operate 
on a data block within your airspace that is owned by another sector, e.g. unintended handoff.  It may also 
be needed when a program bug doesn't produce a handoff to you.  To allow recovery from any type of bug, 
the program allows gaining control of any datablock, including after a handoff to another facility.
"/TT" can be used to change an interim altitude when you no longer own a data block without stealing 
ownership.  [ERAM?]  Real world use would depend on facility procedures and/or coordination.  At present, 
these overrides are applied even if the new owning facility is a Tracon.
If present, the world's fastest D-side will take care of Flight Data items QQ, QS, QU/Track Reroute, AM 
RAL, AM RTE, and VCI On/Off (if allowed by a menu item), when you transmit to an airplane, and QR when 
a non-Mode C aircraft reports its altitude to you.  The D-side uses overrides if necessary.
A function not related to the D-side is automatic handoff initiation from the active sector.  This is a normally 
enabled computer function that will happen whenever the caret symbol '^' is not shown above or to the left 
of the data block.  More details in eATS.PDF, Automatic Handoff section.
QU/Track Reroute attempts to predict the appropriate sector for handoffs.  It may not produce what is 
desired during altitude changes with shelves, or if the aircraft position at the time of the reroute is outside of 
the active sector.  You should be able to restore a desired handoff target using QZ with an altitude in the 
target sector.  The default track line display shows the handoff sectors because the program isn't going to 
always get it right.  You can turn off that data element with a menu selection if you don't like it.
A switch on the A.I. menu allows or disables the D-side doing a QU to a nearby fix on a SID or STAR.  This 
action can cause problems with the altitude logic and handoff sectors.  The default is unchecked, no action 
by the D-side.  The assumption is you have done some minor vectoring and then issue a direct to get back 
onto the SID/STAR at a fix within your sector, or you gave a small short cut.  If auto hand became inhibited 
due to distance off course, it will re-enable approaching the original course.  You can always make the QU 
entry if you want it.
18 JUNE 2025 eATS Computer Commands Page  4
=== PAGE 5 ===
Command Table
The final element in a command is <enter> (usually not shown), or a mouse click.
A space is required to separate other elements.  Using a QAK, function key, or mouse click will 
automatically add a space before, or a space after.
For Q-commands where '/OK' is implemented, the order must be: Q-item  /OK  other fields.  A low priority 
item is to allow it anywhere on the input line.
18 JUNE 2025 eATS Computer Commands Page  5
=== PAGE 6 ===
Action Requirements Command Notes
----------  TRACK  ----------
(Most require plugged in)
Accept 
Handoff
Data block handing to 
your sector.
<FLID ♦> If not plugged in, or is handing to a 
different sector, this is processed as a  
display action (which will make the data 
block disappear).
Accept 
Override 
Handoff
Target tracked.  Data 
block has to be 
displayed if using 
mouse click.
/OK <FLID ♦> CAREFUL !!!  Handing off later may require 
a QU/Track Reroute to get things back in 
sync.  Communications not changed (may 
have to use interphone).  If a normal 
accept would work, /OK is ignored.
Initiate 
Handoff
You have track control. 
Target sector is one of 
the next two in the 
ATC flight plan.  Data 
block is not already in 
handoff.
<Sector ID> <FLID ♦> Will eventually start automatically if auto 
hand is enabled for this aircraft.  You may 
prefer to initiate earlier as soon as an 
aircraft is clear of other traffic.
Also for non-radar airplanes in CST to 
make freq changes and other functions 
work.  Additional programming required to 
make this realistic.
Retract 
Handoff
Handoff has been 
initiated on a data 
block you own and not 
yet accepted by 
another sector.
<FLID ♦> Auto hand is disabled.  Manually initiate 
handoff later and/or enable auto hand (QA) 
for this aircraft.  Field E handoff indicator 
not updated (cleared).
Auto Hand If trying to enable, the 
logic may inhibit again 
for various reasons.
QA <FLID ♦> Enables/Inhibits auto hand for one aircraft. 
Inhibiting to a Sector or a Facility not 
programmed yet.
Track Owned datablock in 
CST.
QT<left click><FLID>
QT //<fix> <FLID>
Initial support for non-radar operations.  
Move datablock in CST to another position. 
FLID must be typed.  No space if after a 
left click.
Drop Track Aircraft landed and is 
in CST.
QX <FLID ♦> Deletes data block from display.  To make 
internal bookkeeping easier, only works 
after receiving "landed" report.  Before QX 
is allowed in general, need to program the 
start track function to recover from 
mistakes.
----------  FLIGHT DATA  ----------
(Most require plugged in, own data block)
Assigned 
Altitude
QZ ddd <FLID ♦> Change long term cruise altitude.  Use 3 
digits for altitude or flight level.  Note -- 
recomputes handoff sectors by doing a 
track reroute from present position.
18 JUNE 2025 eATS Computer Commands Page  6
=== PAGE 7 ===
Action Requirements Command Notes
Assigned 
Altitude and 
Uplink
CPDLC eligibility QZ /U ddd <FLID ♦>
QZ ddd /U <FLID ♦>
Also uplinks the altitude to the pilot, as 
"climb and maintain" or "descend and 
maintain".  See CPDLC chapter for 
description of green underline, wilco, etc.
Interim 
Altitude
QQ ddd <FLID ♦> Enter temporary altitude during climbs and 
descents.  1 to 3 digits.
Interim 
Altitude and 
Uplink
CPDLC eligibility QQ /U ddd <FLID ♦>
QQ ddd /U <FLID ♦>
Also uplinks the altitude to the pilot, as 
"climb and maintain" or "descend and 
maintain".  See CPDLC chapter for 
description of green underline, wilco, etc.
Delete
Interim 
Altitude
QQ <FLID ♦> Remove temp altitude.
Interim 
Altitude
Data block not owned. QQ /TT ddd <FLID ♦>
QQ /TT <FLID ♦>
1 to 3 digits.  Don't know if in ERAM.
Reported 
Altitude
QR ddd <FLID ♦>
QR <FLID ♦>
QR /OK ...
Second option reports level at the assigned 
or interim altitude.  If Mode C is being 
received, the datablock will not show the 
QR altitude.  If Mode C is not received 
(non-radar), the most recent QR altitude 
will appear in the datablock.
Uplink Cross 
Fix at 
Altitude, 
optional 
Speed
CPDLC eligibility. UC <Fix> A<alt> <FLID ♦>
UC <Fix> A<alt> 
S<speed> <FLID ♦>
Must use a Fix named in the flight plan.  
No abbreviated names.  General limits as 
in popup dialog – Altitude (FL) 010-600, 
Speed 100-380.
A.I.T. Data block handing 
from a Center sector to 
your Center sector.
<FLID ♦>
QQ ddd <FLID ♦>
<Sector ID> <FLID ♦>
Approximates an Automated Information 
Transfer (AIT) procedure.  Accept handoff, 
enter interim (optional), initiate handoff, 
each within 8 seconds.  Previous sector 
assigns the altitude you enter and switches 
comm to the following sector.  See General 
chapter in eATS.PDF.
Track 
Reroute
QU <fixes/left clicks ...>  
<FLID or RIGHT click on 
position symbol>
QU LAX N1234X
QU SEA PDX N1234X
QU /OK ...
<fixes> is a series of fixes or LEFT click(s) 
on the map.  Final fix must be point in 
current flight plan.  (Type it, or click 
tolerance is 1.5 miles.)  Present position 
automatically added before first point. 
Displays route line for 10 seconds.  Can't 
change destination yet.  Airplane needs to 
be told the new route.  Use AM if airways 
involved.
Track 
Reroute and 
Uplink (one 
fix)
CPDLC eligibility QU /U <fix> <FLID/right click>
QU <fix> /U <FLID/right click>
Also uplinks "direct to <fix>" to the pilot.  
See CPDLC chapter for description of 
green underline, wilco, etc.  Use full fix 
name (1 or 2 characters is a radio option).
18 JUNE 2025 eATS Computer Commands Page  7
=== PAGE 8 ===
Action Requirements Command Notes
Enter 4th Line 
Heading 
/Speed
QS ddd <FLID ♦>
QS /ddd <FLID ♦>
QS ddd/ddd <FLID ♦>
QS /OK ...
Enter heading and/or /speed.  Heading is 
ddd.  Speed is /ddd.  May use /Mdd or 
/M.dd for mach number.  May append '+' or 
'-' to speed or mach. Replaces 4th line data.
Enter 4th Line 
/Speed and 
Uplink
CPDLC eligibility QS /U /ddd <FLID ♦>
QS /ddd /U <FLID ♦>
QS /U /RNS <FLID ♦>
QS /RNS /U <FLID ♦>
QS /OK ...
Also uplinks the speed, mach, or Resume 
Normal Speed to the pilot.  See CPDLC 
chapter for description of green underline, 
wilco, etc.  RNS is displayed after the 
uplink and before a response is received.
4th Line Text QS =<text> <FLID ♦>
QS /OK ...
"=" seems like a good symbol for Windows 
keyboards.  Replaces 4th line data.
Delete 4th 
Line Data
QS * <FLID ♦>
QS */ <FLID ♦>
QS /* <FLID ♦>
QS /OK ...
Delete all 4th line data, or just heading, or 
just speed.  If all deleted, uses Data Block  
menu selection for line 4 Destination.
Show/Hide 4th 
line data
QS <FLID ♦>
Click on HSF symbol
Heading-Speed-Free Form indicator ( ¬ ) is 
shown to the right of datablock line 3 if 
corresponding line 4 QS data is present.  If 
QS data is hidden or blank, uses Data 
Block menu selection for line 4 Destination.
VCI on/off //<FLID ♦>
Click at VCI position
Turn Voice Communication Indicator on/off. 
Symbol location and click area is just left of 
ERAM datablock line 2.  VCI must be on 
for CPDLC dialog to show the frequency 
change option.
D-side updates automatically if allowed by 
item on A.I. menu.  May change your entry.
Release 
CPDLC 
eligibility
RE <FLID ♦> Details in CPDLC chapter, Datalink Status 
section.
Steal
CPDLC 
eligibility
VCI On.  Current 
eligibilty is within the 
active Center, or not 
assigned.
SX <FLID ♦> Details in CPDLC chapter, Datalink Status 
section.
Code 
Request
QB <AID/CID/♦> Computer assigns a discrete transponder 
code, e.g. oceanic to domestic.
Code 
Modification
QB oooo <AID/CID/♦> Assign a specific code, 4 octal digits.  
Rejected if discrete code in use by another 
aircraft.
18 JUNE 2025 eATS Computer Commands Page  8
=== PAGE 9 ===
Action Requirements Command Notes
Enter Flight 
Plan
Flight plans are 
normally read from the 
data files.  Since this 
function is probably 
used for testing, you 
can use it without 
being plugged in.
FP Call Sign Type TAS Fix 
[D|E]XX00 FL Route
Airborne:
N1234X C172 105 LAX 
EXX00 80 
SAN./.LAX..SFO
On ground:
DAL123 A359 480 KLAX 
DXX00 340 
KLAX..RZS..BSR..KSFO
Only time option so far is XX00 (= now). 
Flight will become active in a sweep or two.
Use time EXX00 to start airborne.  Fix 
must match item after "./." in route. 'E' 
refers to estimated time.  XX00 means 
offset zero minutes from now.
Use time DXX00 to start on the ground.  
Fix must match first item in route. 'D' refers 
to departure time.
Show Flight 
Plan
QF <FLID ♦> Output format is: CID AID Type Beacon 
TAS Fix Time Altitude ReqAlt Route 
Remarks.  For now route elements have 
spaces between to allow the edit window to 
automatically wrap to the next line.
Route 
Readout
AM <FLID ♦> Show ATC flight plan route (field 10).  This 
option has the proper dots instead of 
spaces, but will not wrap to the next line. 
Beacon AM <FLID> BCN oooo
AM <FLID> 04 oooo
AM <FLID> 4 oooo
Change beacon code.  BCN is field 4 (of 
11) in Show Flight Plan/QF description 
above.  Similar to QB/Code Modification.
Assigned 
Altitude
AM <FLID> ALT (d)dd
AM <FLID> 08 (d)dd
AM <FLID> 8 (d)dd
Change assigned altitude.  ALT is field 8 
(of 11) in Show Flight Plan/QF description 
above.  Similar to QZ/Assigned Altitude.
Requested 
Altitude
AM <FLID> RAL (d)dd
AM <FLID> 09 (d)dd
AM <FLID> 9 (d)dd
Change pilot requested altitude.  Work in 
progress to make consistent with 3 other 
cruise altitudes.  RAL is field 9 (of 11)  in 
Show Flight Plan/QF description above.
Route AM <FLID> RTE route
AM <FLID> 10 route
See Field 10 Route Amendments section 
below.
AM accepts multiple field pairs.
Delete field contents not programmed.
AM N1234X BCN 4531 ALT 80 RAL 110
----------  DISPLAY  ----------
(Most do not require plugged in)
Data Block 
Offset
<direction> <FLID ♦>
/ <length> <FLID ♦>
<direction> / <length> 
<FLID ♦>
Direction is 1-9 oriented as computer 
number pad (1-2-3 on bottom).  Direction 5 
sets relative to current track.
Length is 0 to 5.
Search eATS.PDF for "1-2-3" for 
instructions if you have a 1-2-3 on top 
number pad.
18 JUNE 2025 eATS Computer Commands Page  9
=== PAGE 10 ===
Action Requirements Command Notes
Force Data 
Block
Data block not 
displayed
<FLID> or Left-click on first 
target symbol (backslash).
Display data block.
Force Data 
Block
Data block displayed 
but not owned.
<FLID ♦> Remove (not owned) data block.  
Request
Data Block
Data block not 
displayed.  Target 
tracked.
QP <FLID> or 
QP Left-click on first target 
symbol (backslash).
Display data block.  Does not "accidentally" 
accept handoff if it starts flashing at you at 
the same time.
Suppress 
Data Block 
not 
implemented
Data block displayed. QP <FLID ♦> Not implemented yet.
Point Out Plugged in. QP <Sector ID> <FLID ♦> Display data block at another sector, which 
doesn't do anything, but you can make the 
entry.  May be useful if an interphone 
system is programmed.
Sector ID is a 2 digit internal sector, or 
<letter><number><number> for an external 
Center sector.  More error conditions to 
detect.
Point Out 
Approved
Plugged in.  Data 
block not owned.
QP A <FLID ♦>
Click on P above datablock
If P shows above non-owned data block, 
approves the point out.  AI hands to next 
sector at appropriate time.
Remove 
Point Out 
Indicator
Plugged in.  Data 
block owned.
QP A <FLID ♦>
Click on P above datablock
If P shows above owned data block, 
removes the P.  You did not accept the 
point out before accepting the handoff.  
Airplane was/will be transferred to your 
frequency.
To simplify the programming, if you accept 
the handoff and leave the P displayed, it 
will be removed when the next sector 
accepts your handoff.
5 mile Halo Target displayed.  
Does not have to be 
owned by player.
QP J <FLID ♦> If no halo or a 3 mile halo, displays a 5 mile 
halo.  If 5 mile halo, turns halo off.
3 mile Halo 3 mile menu item 
selected.  Airplane at 
or below FL230.  
ERAM datablock 
format. Target 
displayed.  Does not 
have to be owned by 
player.
QP T <FLID ♦>
QP J 3 <FLID ♦>
If no halo or a 5 mile halo, displays a 3 mile 
halo.  If 3 mile halo, turns halo off.
A 3 mile halo becomes a 5 mile halo if an 
airplane climbs above FL230.
Reposition 
Strips 
(In Sector 
and 
Outbound)
QP S Left-click Click defines lower left corner of list.  List 
grows upward. Intended for lower portion 
of screen.
18 JUNE 2025 eATS Computer Commands Page  10
=== PAGE 11 ===
Action Requirements Command Notes
Reposition 
Inbound List
QP I Left-click
      ^---- letter
Click defines upper left corner of list.  List 
grows downward.  Intended for upper 
portion of screen.
Reposition 
Departure 
List
QP D Left-click Click defines upper left corner of list.  List 
was mostly for debugging time calculations 
for departure spacing, and is now initialized 
off-screen.  Click somewhere on-screen if 
you want to see it.
Reposition 
Metering List
QP M Left-click Click defines upper left corner of list.  List 
grows downward.  Intended for upper 
portion of screen.
Reposition 
Keypad Stack
QP K Left-click The Zoom buttons, CRD, QAK keys, 
Number Pad, and Comm receive/transmit 
windows may be moved as a group to a 
new location.  The click position defines 
the new lower right corner, adjusted to 
avoid off-screen left.
Route 
Display
QU <FLID>
QU RIGHT click on 
position symbol
Display/remove route line for FLID.  Up to 
3 may be shown.  All disappear 10 
seconds after last entry.  Can ignore 
timeout using QU/Track menu item.  Other 
menu items show climb/descent calculation 
points and the pilot route.
Start point of track is only updated with a 
Track Reroute.  The orange dot in the 
"show all data" option is the first step in  
making the start point move appropriately.
QU left-click makes the entry a Track 
Reroute, described in the Flight Data 
section.
Route 
Display
Off
QU <enter> Removes all QU route lines now.
Quick Look QL < sector/airport ID(s) >
QL 36 43
QL LAX
QL <enter>
QL ALL
Shows full data blocks in selected (non-
active) sectors within facility, and/or 
airplanes with matching destination 
airports.  Adds to existing list up to 5 items. 
Turn off with no ID.  ALL to show 
everything.
18 JUNE 2025 eATS Computer Commands Page  11
=== PAGE 12 ===
Action Requirements Command Notes
Altitude 
Limits
QD dddBddd QD 078B242 displays all limited data 
blocks between 7800 feet and FL242.
Normally the limits are 1200 feet above 
and below your sector's altitudes (to make 
traffic calls – not implemented yet).  Many 
functions that change the sector 
configuration automatically adjust the 
limits, and will change the values that you 
set.
Limited data blocks for all aircraft that will 
be handed off to you are shown regardless 
of the QD limits.
Altimeter QD <airport ID>
AR <airport ID>
Display one altimeter setting.  May use 3 or 
4 letter ID.  Station must be named in a 
*WX entry in the facility DATA file.  
(Commands similar to real system, but 
program does not display in the same 
manner.)
Conflict 
Suppress/ 
Request
CO <FLID ♦> <FLID ♦>
Mouse click(s) processed 
on present position slash 
of a full data block, but if 
none are nearby will use a 
limited data block.
Stop (or re-enable) blinking of a pair of 
data blocks.  Conflict logic not processed 
every sweep, might take 15 seconds.  
Changing active sectors clears all 
suppressed pairs.
Useful when not plugged in and you can't 
do anything about it, or for traffic in 
adjacent sectors not separated by the A.I.
Strip Request SR <FLID ♦> On/off.  Force 2 line format for In Sector 
strip when within radar coverage.  Non-
radar In Sector always uses 2 line.  
Outbound strips are always 1 line.
Note – 2 line strip marking is tied to radio 
communication.  Minimal updates when not 
plugged in.
Upper
Winds
UR One set of winds at a time for everywhere. 
Table shows flight level, true direction, 
speed.  Winds change on selecting a 
facility, and with WIND and NEWWINDS 
commands below.
18 JUNE 2025 eATS Computer Commands Page  12
=== PAGE 13 ===
Action Requirements Command Notes
----------  CONTINUOUS RANGE READOUT  ----------
Define Group 
Name
LF //<fix>
LF //<fix> <Group>
LF //WYNDE
LF //WYNDE W
LF //WYNDE090010 W10
If <fix> is 5 characters or less, Group 
Name does not have to be typed, and will 
be the same as the <fix>.  Fixes with more 
than 5 characters (e.g. lat/longs) must 
specify Group Name.
Group Name may be 1 to 6 characters.  
"ALL" is not allowed, because it has 
special meaning in CRR entries below.  
The same fix may be used in multiple 
Groups.
All LF // definitions are deleted when a new 
facility is loaded.
User Data files may be used to store LF 
entries for each sector.  See Data Files 
PDF, search for LF.
Show/Hide 
Range 
Readout for 
Airplane(s)
LF <Group> <FLID  ♦>
LF <Group> FLID/FLID/...
LF W <click>
LF WYNDE 182
LF W10 234/765/N1234X
Mouse click OK if one airplane. Multiple 
airplanes (no limit) may be separated with 
'/'.
If an airplane had no Group assignment or 
was assigned to a different Group, the 
range to the fix associated with the 
specified Group is displayed.
If an airplane was already assigned to the 
specified Group, the airplane is removed 
from the Group and the range readout 
disappears.
Expected use is with CIDs, but other forms 
of Flight ID also work.
Items with similar functions are only
controlled by mouse actions in the real system
List CRR LIST Lists current LF // definitions.  May not fit in 
the CRD output window.  Note – some 
database errors will prevent CRRs from 
loading.  Check Log File.
18 JUNE 2025 eATS Computer Commands Page  13
=== PAGE 14 ===
Action Requirements Command Notes
Set 
Characteristic 
of one Group
CRR <Group> <Value> <Value> may be:
DELETE   deletes LF // definition
SMALL    use small datablock font
LARGE    use large datablock font
WHITE   or W   set color
GREEN  or G    set color
PINK       or P    set color
YELLOW or Y    set color
Set 
Characteristic 
for All Groups
CRR ALL <Value> If <value> is a font or color, changes the 
display of all current ranges, and sets 
default for new LF // Groups for this run.  
Program is initialitzed with SMALL and 
WHITE.
ALL DELETE (or loading a different facility) 
deletes all LF // definitions.
18 JUNE 2025 eATS Computer Commands Page  14
=== PAGE 15 ===
Command Example Action
----------  FACILITY AND SECTOR  ----------
XX FAC LLL XX FAC ZMP
XX FAC ZMP SEC 16
Make facility active.  Erases all airplanes.  May select a 
sector in the same command.  Not plugged in after change.  
Produces new altimeter settings and surface wind.  Centers 
defined – ZAN, ZHN, ZSE, ZOA, ZLA, ZLC, ZAB, ZMP, ZDV, 
ZKC, ZFW, ZHU, ZAU, ZID, ZME, ZOB, ZTL, ZMA, ZJX, 
ZDC, ZNY, ZBW.
XX SEC dd XX SEC 16 Make sector active.  Not plugged in after change.  Think 
walking across the control room to another sector.
XX COMBINE dd
XX COMB dd
XX COMBINE 15
XX COMB 15
Add another active sector.  Keeps existing airplanes.  Will 
stay plugged in.  May enter as one command:  XX FAC ZOA 
SEC 29 COMB 32
XX REMOVE dd XX REMOVE 16 Makes sector inactive.  Keeps other active sectors, keeps 
existing airplanes, will stay plugged in.  Possibly less 
confusing term than "split".
XX MID dd
XX MID <area>
XX MID 32
XX MID A
If midnight shift configuration is defined in the data files, 
selects/combines/activates all sectors within a work area.  
Configs are displayed in XX LIBRARY window.  Does not 
change clock time or time-of-day traffic selection.
XX CLOSE Fac Sec
XX OPEN Fac Sec
XX CLOSE ZAU 23
XX OPEN MSN 1A
Changes FPA ownership based on *CLOSE target in sector 
definition.  Used to split Super High airspace for assignment 
to multiple sectors below, and for taking over Tracon airspace 
after hours (5 mile separation).
Need both Fac and Sec in this command.  Other sector 
selection operations only apply to sectors within the active 
facility, and Fac is not inlucded in those commands.
May take some time to build new ATC Tracks for each 
airplane.  Fast if used before airplanes are active.
XX CLOSE ALL
XX OPEN ALL
Opens or Closes all Sectors and Tracons that have *CLOSE 
targets defined in the database.
CLOSE ALL is likely to be appropriate for the midnight shift.  
Normally CLOSE on an active sector is rejected.  CLOSE 
ALL is accepted if there is more than one active sector, which 
means it can be used after XX MID without extra steps.
When a different facility is loaded, all sectors are initially 
open.  When the same facility is reloaded, closed sectors 
remain closed.
XX CLOSE LIST Shows which Sectors and Tracons are able to be closed 
(have *CLOSE targets).  A list of currently closed sectors is 
always displayed in the upper left.
XX RELOAD Erases all airplanes and reloads same facility and active 
sectors.  One use is to re-read data files after editing.  Will 
stay plugged in.  No confirmation dialog, but after all that 
typing I assume you meant to do it.
18 JUNE 2025 eATS Computer Commands Page  15
=== PAGE 16 ===
Command Example Action
XX WORK Use instead of mouse clicks on menu items and check 
boxes.  As necessary changes status to airplanes on, 
plugged in, D-side.  Typical use on program start up: XX FAC 
ZBW SEC 22 WORK
XX WATCH Use instead of mouse clicks on menu items and check 
boxes.  As necessary changes status to airplanes on, 
unplugged.  Typical use on program start up: XX FAC ZBW 
SEC 22 WATCH
----------  TRAFFIC   ----------
XX ACGEN Turns aircraft generator on/off.  Existing airplanes continue.  
The "Airplanes Off" switch on the File menu erases all 
airplanes right now.
Current traffic level percentage remains the same.  If was 
zero, remains zero.  If off and any sectors selected, status 
message in green in upper left.
XX ACGEN ddd XX ACGEN 75 Sets traffic level from 0 to 200%.  Existing airplanes continue, 
including those approaching the active sectors. May take 
some time to stabilize at the requested value.
The design load is 15-20 airplanes, depending on the type of 
sector.  Traffic is adjusted based on the flight plans defined to 
operate during the current or selected time of day.
Adding a second sector automatically reduces the new traffic 
generated, because this is expected to be a fairly common 
operation.  If you combine 3 or more sectors during busy 
times, you will probably want ACGEN at something less than 
100%, maybe 65%, and 4 sectors 55% etc.
Value is shown in upper left if not 100%.  Shown in white (i.e. 
a normal operation) except 0% shown in green.
XX DAYTRFC Switches On or Off.  Regardless of other time settings, picks 
from all "daytime" flight plans that operate between 0500 and 
2259 facility local time.  Displays DAYTIME TRAFFIC near 
clock.  Will generate the most traffic.
The only way to see flight plans with times between 2300 and 
0459 local is when the local time is within that range (real 
time or LOCAL time option), and DAYTRFC is turned off.
XX LOCAL dd XX LOCAL 8
XX LOCAL 23
XX LOCAL -1
Sets local hour for facility in use and adjusts GMT.  CLEARS 
FLIGHTS AND RESTARTS because existing times will be 
invalid.  Use -1 to turn off override and use real time.  Uses 
flight plans and traffic levels for designated facility local time.  
Displays SIMULATOR TIME near clock.  Minutes remain real 
minutes in case you have an external deadline to be aware 
of.
18 JUNE 2025 eATS Computer Commands Page  16
=== PAGE 17 ===
Command Example Action
XX WARMUP Resets initial start distance outside the active sector to 
program default.  Corresponds approximately to WARMUP 
25, but has more random variation.
XX WARMUP <value> XX WARMUP 50
XX WARMUP -50
Sets approximate distance from sector boundary where first 
airplane is created.  Large value means it will take longer for 
a sector to reach the design traffic level (warm up).
Value 0 to 100.  The first airplane is created on or outside the 
active sector boundary.  The next several airplanes are 
created at increasing distances, up to a program defined 
value.
Value -100 to -1.  Initial airplanes may be created a negative 
distance outside (i.e. inside) the active sector boundary.  
Status message Start Within Sector is displayed.
More in Enroute chapter in eATS.PDF.
XX DEPONLY Departures only.  Switches On or Off.  Uses flight plans 
defined in the Library that start on the ground (not "ORIG./."). 
A flight may be repositioned airborne if the origin is a long 
distance from the active sector, but the general effect is to 
allow working with mostly departures.  Turned off if 
ARRONLY is turned on.  Also on Traffic menu.
XX ARRONLY Arrivals only.  Switches On or Off.  Uses flight plans defined 
in the Library that end on the ground (not "./.DEST").  A flight 
may start on the ground or fly through the active sector if it 
lands somewhere else, but the general effect is to produce a 
higher percentage of arrivals.  Turned off if DEPONLY is 
turned on.  Also on Traffic menu.
XX METERING Display/hide list if metering items defined for facility/sector.  
At present does not affect traffic flow.  Also on Traffic menu.
XX METER_DETAILS Display/hide more information for debugging.  Also on Traffic 
menu.
XX FREEZE Display current value.
XX FREEZE <dd> MIN
XX FREEZE <dd> NM
XX FREEZE 30 MIN
XX FREEZE 200 NM
If METER_RWY used in facility, set Freeze Horizon in 
minutes.  Minutes may be 30 to 60.  Initial value is 30 
minutes.
If METER_APT used in facility, set Freeze Horizon in miles.  
Initial value is different in each facility.
XX AAR Display list of Airport Arrival Rates.  If METER_RWY used in 
facility, lists by landing runway.  If METER_APT used in 
facility, lists by airport.
18 JUNE 2025 eATS Computer Commands Page  17
=== PAGE 18 ===
Command Example Action
XX AAR <rwy> <dd> XX AAR KSFO28L 15
XX AAR KSFO 30
If METER_RWY used in facility, change rate for one 
database metered runway.  If METER_APT used in facility, 
change rate for one airport. Does not accept a new airport 
definition.  Minimum value is 4 airplanes per hour.
Either _RWY or _APT may be defined in the database for a 
facility, but not both at the same time.  Definitions can be 
added to your User Data files, but must match the type used 
in the distribution files, if any.
----------  MAP   ----------
XX CENTER <fix> XX CENTER EGLL Moves map center to designated point.  Can not enter <fix> 
using a mouse click, but see SHIFT+HOME.
XX RANGE <range> XX RANGE 75 Set map range.  Original command before spin buttons and 
keyboard options were programmed.
XX ZOOM <fix> XX ZOOM EAU Set map center to <fix>, range to 40 miles and turns on fix 
labels.  ZOOM buttons for each sector can be defined in the 
data files with a radius other than 40.  Original command 
before zoom buttons were programmed.
XX ZOOM NONE Restores the database center and range.  See table below 
for information on zoom buttons.
XX RECENTER Restores database center and range.  Was original command 
before ZOOM NONE was programmed
XX GRID Turns the latitude/longitude grid on/off.  Green lines. 1 degree 
spacing for small ranges and 5 degree spacing for large 
ranges.  Also on a Display menu item.
XX RINGS Turn range rings (range arcs) on/off.  Also on Display menu, 
Other Lines.  Definitions are in Map section of DATA file, or in 
User Data.
XX LAMB Sets Lambert projection.  Default, and same as used on 
many aeronautical charts.
XX ORTHO Sets Orthographic projection.  Ortho, grid on, range 3200 
looks like a globe.  Not needed for this program but the math 
was there from a previous one.
XX MAGNORTH Aligns map vertical center line with magnetic north.  I have 
not seen a Center display that uses this format.  Code was 
already in the map logic so I enabled it.  Sets projection to 
Lambert.  Selecting a facility and possibly other map actions 
will reset to true north.
XX TRUENORTH Aligns map vertical center line with true north.  Default.
XX TERRAIN If terrain data base installed, turns display on/off. GTOPO30, 
30 arc-second data with reduced vertical resolution.  Also a 
Display menu switch for separate coastline display from 
NOAA GSHHG data.
18 JUNE 2025 eATS Computer Commands Page  18
=== PAGE 19 ===
Command Example Action
XX TERRAIN <d> XX TERRAIN 2 Changes terrain display colors.  1 = dim colors, data blocks 
easier to read (default).  2 = approximate VFR chart colors, 
data blocks hard to read. 3 = dim grays, better for higher 
average terrain. 4 = bright grays, better for lower average 
terrain.
XX BLUE <ddd>
XX BLUE
Changes blue background level, or displays current level.  
Default is 25.  Range 0 – 255.  Recommend values well 
below 100.
XX WHITE Changes map background to white.  Might be useful for 
taking a screen shot, editing, and printing a map, should 
anyone still be using their printer.  Colors do not work well for 
data blocks and some other elements.  Use XX BLUE <ddd> 
to get back to normal.
XX SHOWLL On/Off.  Displays lat/longs of boundary points.
XX SOLID1 Turns on/off lines defined as SOLID_LINE_1.  Also on a 
Display Menu item.  Used to draw special purpose lines as 
needed.  Line type can be turned on by default by a database 
designation for each sector.  Player may then turn on/off as 
desired.
XX SOLID2 Turns on/off lines defined as SOLID_LINE_2.
XX SOLID3 Turns on/off lines defined as SOLID_LINE_3.
XX AWSEG Turns on/off lines defined as Airway Segments.
----------  RADAR   ----------
XX RADARHOLES Activates/Deactivates holes in radar coverage.  Airplane is 
non-radar if below the surface all radar holes at the current 
position.  Also on Radar menu.
XX SHOWRADARS Brown.  Displays (no-terrain interference) radar horizon of 
some radar sites at selected MSL altitudes.  Used to help 
adjust radar hole parameters.  Not used in calculations.  Also 
on Radar menu.
XX SHOWHOLES Cyan.  Displays location of radar hole surface at selected 
MSL altitudes.  Outer displayed ring is edge of radar hole.  
Also on Radar menu.
XX RADAR <altitude> XX RADAR 10000 Gives distance from sea level to geometric (no atmosphere), 
visual (light refraction), and radar horizons.
----------  ENVIRONMENT   ----------
XX WINDSON
XX WINDSOFF
Turns upper winds on/off.  UR command displays winds.
XX NEWWINDS Creates a new set of winds.  Automatic on selecting a new 
facility and a few other cases.  UR command displays winds.
18 JUNE 2025 eATS Computer Commands Page  19
=== PAGE 20 ===
Command Example Action
XX WINDdddsss XX WIND270050 Mostly for testing.  Sets winds aloft for all altitudes to given 
direction and speed.  No range checks.  Ridiculous values 
may produce ridiculous results.
XX SFCWIND dir spd XX SFCWIND 300 10 Use after selecting a facility if you want different values.  
Direction is rounded to nearest 10 degrees.  Speed may be 0 
to 30 knots.  Value displayed at upper left.  The next XX FAC 
command generates a new surface wind based on the wind 
distribution defined for that facility.
XX QNH dddd XX QNH 2973 Set desired altimeter 28.93 to 30.91.  Work in progress.  
Some affected operations respond, others not programmed.  
Altimeter setting shown at upper left. Random value 
produced on each XX FAC command.  So far should be set 
before airplanes are created – e.g. after this use XX 
RELOAD or select Airplanes Off, then On.
XX NEWPRESSFIELD Set a new random Pressure Field for Individual Station 
Altimeters, in case you didn't like the previous one.  So far 
should be set before airplanes are created – e.g. after this 
use XX RELOAD or select Airplanes Off, then On.
----------  POP UP WINDOWS   ----------
For all pop up windows - If you click on the window, such as to reposition it, Windows directs keyboard and 
mouse input to that window (not useful).  Click on the main window to resume normal inputs.  Some function 
keys will re-select the main window too.
XX LIBRARY
XX LIB
XX LIB OFF
F10 key
Displays arrival restrictions for active sector and other data in 
a pop up window.  F10 key shows/hides this window and the 
Debug Tool window.
XX STRIPWIN
XX STRIPWIN OFF
Ctrl+F10 key
Display menu item
Show/hide separate Strip Window.  Can be dragged to a 
second monitor.  Also hides/shows normal Inbound an In-
Sector strip lists.
(Debug Tool)
XX FMC <FLID ♦>
XX FMC OFF
F10 key
XX FMC N1234X Displays aircraft flight data in a mixed Airbus/Boeing/made-up 
Flight Management Computer format.  This is a debugging 
tool, not an airplane simulator.  If you know how any FMC 
operates you will get the idea.  Displayed values are NOT 
always what would you would see in a real airplane.  Not 
necessary to use the program.  F10 key shows/hides this 
window and the Library window.
XX FMC
XX TRACK
XX TRACK <FLID ♦>
Sets Debug Tool window to airplane FMC format or ATC 
Track values (altitudes, sectors, etc.).  Track format can be 
displayed initially instead of FMC format.  Not necessary to 
use the program.
XX CONFLICT
XX CONFLICT OFF
Displays conflict alert data in a pop up window.  A.I. does not 
apply separation except when airplanes are initialized.  This 
is the first step in researching how that might be improved.
XX DATAFOLDER Same as menu item File, Open Data and Log Folder.
18 JUNE 2025 eATS Computer Commands Page  20
=== PAGE 21 ===
Command Example Action
XX KEYPADS
Shift+F10 key
Display menu item
Show/hide on-screen keypads.  Moves comm windows and 
Zoom buttons.  Moves In Sector strip list if database position 
is "Right", and the player has not moved the list with QP S.
----------  SIMULATION CONTROL AND INFORMATION   ----------
XX PAUSE Stops or starts the program clock.  When paused, the comm 
window, other XX functions, and mouse clicks within the map 
area are disabled.  After restarting, and until the next 
database re-read, "TIME OFFSET" is displayed to show that 
program minutes and seconds are not in sync with your 
computer clock.
Some items that only affect the display continue to operate.  
Results may not be apparent until un-paused.  A function that 
would  normally use a mouse click, such as repositioning a 
data block, will work if you type the CID or call sign.
XX INFO <identifier> XX INFO KLAS
XX INFO V13
XX INFO KLAX-ANJLL4
XX INFO KEGE-LDA25
Shows data base infrormation about airports, navaids, 
airways, SIDs, STARs, approaches.  There is a hyphen 
between an airport and a procedure name.  Zero substitution 
on procedure names not programmed.
Procedures with multiple transitions and long airways will 
probably overflow the CRD display area.  Transitions and 
breaks in airways are separated with "=".
XX LOG <FLID ♦> FMC and Track values to log file for one aircraft.  Similar to 
data in Debug Tool window.  Contents change depending on 
what I need for debugging.  File menu option opens folder 
containing LogFile.txt.
XX ALERT Turn on/off alert sound played when an airplane initiates most 
conversations.  Also on File menu.  Start Option available.
XX COMMQ Print airplane pending communications queue to log file.
XX COMMQCLEAR Clear pending communications queue for everybody.  Can 
use if an airplane won't respond to acknowledgements and 
quit calling you. A less severe alternative is transmitting "<call 
sign> ??", meaning "how do you read", which should clear 
that airplane's comm queue.
XX RPTQ Print airplane pending report queue to log file – report 
leaving, report entering hold, etc.
XX FREQ <Fac> 
<Sec>
XX FREQ ZAB 68 Frequencies you need are almost always displayed in the 
Strips List.  Data for external sectors is only loaded for 
sectors adjacent to the active facility. This function does not 
handle single letter facility IDs.
XX DEST3ON
XX DEST3OFF
Turns off/on single letter data block destination code in line 
three (if defined in facility data files).  Also on a Data Block 
menu item.
XX DBCOLOR Changes data block color between yellow and white.
18 JUNE 2025 eATS Computer Commands Page  21
=== PAGE 22 ===
Command Example Action
XX FONTS Switches on/off.  Displays a list of fixed pitch fonts available 
on your system in 8 point.  Last line is END OF LIST if all fit 
on your screen.  Log file shows fonts requested by the 
program on start up.  Up arrow, down arrow, and caret are 
from the Unicode characters found in most fonts.
User control of font/size will be added to the program 
sometime.  Method to be determined.
XX ERAMFONTS Switches on/off.  Displays a group of weights and sizes for 
one or two fonts selected by an *ERAM_TEST_FONTS entry 
in eATS.txt.  More in Data-Files PDF, User Data chapter.
XX AUTORUN Executes a set of XX commands defined within an 
AUTORUN block in eATS.txt.  Example in Data-Files.pdf
----------  DATABASE CONSISTENCY   ----------
XX MINUTERUN XX MINUTERUN ZSE 
ZAB ZLC
Not useful unless you are doing extensive database 
modifications.  Runs each facility for about a minute.  Check 
the log file for errors.
XX CHECKFPLIB Not useful unless you are doing database modifications.  
Checks the flight plan library for the active facility for errors, 
and writes to log file.  The only checks so far are for flight 
plans that start airborne or end airborne within the active 
facility.  MINUTERUN also does this for each facility.
XX LOGENTERSFAC 
<Fac ID>
XX FAC ZAU WATCH
XX LOGENTERSFAC 
MKE
Writes flight plans to the Log File that enter the requested 
facility from the active facility.  Example extracts active ZAU 
flight plans that go through MKE airspace.  Copy results from 
Log File to User defined Tracon flight plan file.  May take 5 
minutes to process every flight plan.
----------  CALCULATOR AND MORE   ----------
XX DRAW <space 
separated elements>
XX DRAW <field 10 
format with '.'>
XX DRAW
XX REDRAW
XX DRAW OBH 
45N090W GCO180020 
KLAX25L
XX DRAW SFO 
TRUKN0 DEDHD RBL 
ILS34 RDD
XX DRAW 
SFO.TRUKN0.DEDHD.
.RBL.ILS34.RDD
Draws solid line between known elements.  Draws dotted line 
when skipping unknown elements to highlight errors.  If SID, 
STAR, or approach is used, also include origin/destination 
airport.  Handles airport alias and procedure "zero" 
designations.
Can type XX DRAW<space> and then control+V (paste) text 
copied from an external source.
XX DRAW removes line.
REDRAW reinstates previous DRAW, and leaves command 
in input area for further editing, or to recompute wind-aware 
procedures after changing the surface wind.  <ESC> will 
clear input area.
18 JUNE 2025 eATS Computer Commands Page  22
=== PAGE 23 ===
Command Example Action
XX MACH <TAS> 
<FL> [2nd FL]
XX MACH <MACH> 
<FL>
XX MACH 458 350
XX MACH 458 350 390
XX MACH .85 350
If first value is >= 1 converts TAS and FL to MACH.  If a 
second FL is given, shows TAS to get computed MACH at the 
second FL.  Assumes standard temperatures.
If first value < 1 converts MACH and FL to TAS and IAS.
XX GS-TAS <GS> 
<FL> <FIX1> <FIX2> 
<WD> <WS> 
(optional)<TEMP>
XX GS-TAS 408 360 
HEMLO 42N130W 270 
85 -55
produces:
TAS 484 IAS 281 M 84 
TC 243 TH 248 ISA +1
Inverse wind triangle, ground speed to TAS.  Calc TAS from 
observed ground speed, flight level, course, forecast wind.  
Fixes define true course.  Optional temperature (with sign) at 
altitude from winds aloft forecast.
XX RF <Center> 
<Fix1> <Fix2>
XX RF 
N3826.27/W10649.88 
WADDU METVY
Compute points to approximate a Radius to Fix RNAV 
approach leg.  See Data-Files PDF.
XX ICAO <route> XX ICAO DCT DIPSO 
G595 
INVUS/M084F310 
G595 
ATNAT/M084F330 
G595 SOTKI DCT 
RIGMI DCT 
30S170E/M083F350   
DCT 27S180E DCT 
TERAN R582 
NUGLI/M084F370 
R582 URKEP DCT 
21S160W DCT 
19S157W DCT 
14S150W  DCT 
06S140W DCT 
03N130W/M084F390 
DCT 11N120W DCT 
20N110W DCT 
MZT/N0481F390 DCT 
ALRES DCT PNG DCT 
SAT
Converts ICAO format route to NAS format removing DCT, 
speeds, etc.  CRD input is a standard window that accepts 
clipboard data.  May copy/paste from somewhere.  Results 
appear in a pop up window, and are written to the log file.
Route expected to start with ORIG DCT FIX, or ORIG 
AIRWAY FIX, or DCT FIX.  Route expected to end with FIX or 
DCT DEST.
Example (YSSY-KIAH) produces:
..DIPSO.G595.INVUS.G595.ATNAT.G595.SOTKI..RIGMI..30
S170E..27S180E..TERAN.R582.NUGLI.R582.URKEP..21S1
60W..19S157W..14S150W..06S140W..03N130W..11N120W..
20N110W..MZT..ALRES..PNG..SAT
18 JUNE 2025 eATS Computer Commands Page  23
=== PAGE 24 ===
Quick Action Keys
Text 
Command
Quick Action 
Key
Function 
Key
Short Summary
QA AUTO HAND Enable/Inhibit automatic handoff initiation from the active 
sector for one airplane.  Sector/Facility disable not 
programmed.
QB CODE Request/Modify transponder code.
QD CRD Altitude limits for display of limited data blocks.  Shown in 
upper left corner of screen.  Limits were shown on the R-
CRD in NAS Stage A.
QF SHOW FP F2 Show ATC flight plan.
QH HOLD Not yet programmed.
QL QUICK 
LOOK
Sector ID(s) separated by spaces, blank to clear, ALL
QN "None" key refers to commands that don't require a QAK 
or even the "QN" prefix, and include accepting and 
initiating a handoff and positioning a data block.
QP PVD F7 Historical name of the "radar screen" is Plan View Display. 
Refers to displaying something on a PVD somewhere.
QQ INT ALT F8 Interim altitude.  Used during climbs and descents for a 
temporary altitude.  Displays "xxxTxxx" in the data block.
QR REPORT Enter pilot reported altitude (if Mode C not available).
QS HDG SPD F12 4th line data.
QT TRACK Not yet programmed.  Everybody auto-acquires so far in a 
manner that is convienent for the program.
QU ROUTE F3 Enter flight plan reroute points or display/remove track 
line.  Additional display options on QU/Track menu.
QX CANCEL Drop Track after an airplane has landed.  Other uses, but 
not until start track QT is programmed.
QZ ASGN ALT F5 Used to change a long term cruise altitude.  Uses '^', 'v', 
and 'C' in the data block.  Affects target handoff sectors.  
QZ vs. QQ had other implications in NAS Stage A 
regarding printing strips.
CO CO Conflict Suppress/Request (blinking data blocks)
FP ENTER FP Create a new flight plan.  Details above.
AM AM Flight plan amendment.
DM DM Not yet programmed. Departure Message.  Function is 
automatic in a manner that is convienent for the program.
RNG BRG F4 Compute distance and bearing between points.  Other 
options described above.
HOME Cursor to center of map area.
18 JUNE 2025 eATS Computer Commands Page  24
=== PAGE 25 ===
Keyboard Shortcuts
Windows Keyboard
KEY
FUNCTION
HOME Move cursor to map center.  Not the physical screen 
center because of the buttons, etc. on the right side.
SHIFT + HOME Move map center to cursor.
PAGE UP Increase vector line length.
PAGE DOWN Decrease vector line length.
SHIFT + PAGE UP Increase map range.
SHIFT + PAGE DOWN Decrease map range.
F1
Function key F2 "QF "  Show flight plan
Function key F3 "QU "  Route display/modify
Function key F4 Range-bearing
Function key F5 "QZ "  Assigned Altitude
F6
Function key F7 "QP "  PVD
Function key F8 "QQ "  Interim Altitude
F9
Function key F10 Library and FMC windows on/off
Shift + F10 On screen Keypads on/off
Ctrl + F10 Strip Window on/off.
F11
Function key F12 "QS "  4th Line Heading/Speed/Text
ESC or ESCAPE Erases contents of CRD or Transmit window without 
taking any action.
SHIFT + hover over 
present position slash
Show flight plan and route line (QF QU).  May be 
replaced by a more realistic function if available.  
Looks at full data blocks first, but if none are nearby 
will use a limited data block.
18 JUNE 2025 eATS Computer Commands Page  25
=== PAGE 26 ===
Zoom Buttons
click on ZOOM NONE button
Restores the center and range in effect before other 
Zoom buttons were used.  This will be a manually set 
center and range, or the database center and range if 
no manual adjustments were made.
Changing the sector configuration sets the database 
center and range.  Subsequent adjustments using 
spin buttons, XX commands, menu items, or 
keystrokes will be remembered when Zoom None is 
used (until the next sector configuration change).
Shift + click on ZOOM NONE button Restores database center and range.  Same 
response as menu item Display, Zoom None.
The programming is designed for two styles.
If you like the database center/range and only use zoom buttons, ZOOM NONE and Shift+ZOOM NONE 
do the same thing.
If you manually adjust the center/range after loading a sector, ZOOM NONE gets you back to the last 
manual center/range, and Shift+ZOOM NONE sets the database values.
click on other zoom buttons
Sets center and range defined in the DATA file.  Also 
displays fix labels.
If you want to remove the labels while zoomed, use 
menu item Display, Symbols, Labels or the Labels 
check box.  It may take 2 clicks to get the display in 
sync with the check marks.
CAUTION – if the mouse is positioned over a zoom button, some Windows functions are inhibited, probably 
because the active window is considered to be the button.  Clicking on any zoom button automatically moves the 
cursor off the button to avoid this problem.
18 JUNE 2025 eATS Computer Commands Page  26
=== PAGE 27 ===
Field 10 Route Amendments
If a route amendment contains only fixes, either AM or QU may be used.  The most common route change 
is expected to be present position direct to a fix in the current flight plan, and that QU will be used.  The 
options available for field 10 correspond to the radio commands available for route changes.
Airway/SID/STAR/Approach modifications must use AM.  Field 10 may be specified with "10" or "RTE".  
The program has limited use for field 6 (fix) and field 7 (time), and no user-modifications to those fields are 
programmed.
The first AM route element is a fix (any of the legal formats) near the present position of the airplane.  You 
do not have to be exact.  The updated track will begin at the position you enter.  The present position is not 
part of the radio command.  The D-side has an uncanny ability to eyeball the position of the airplane for the 
initial AM fix.
The last fix of the new route must be in the current route.  If the current route ends with FIX./.DEST, only 
fixes up to FIX are considered.  If the last fix of the new route is not the destination airport, the previous 
route after the fix is retained.  If the last fix is the destination airport, and the destination airport does not 
appear twice in the route, all of the original route is replaced.  Changing the destination airport is not 
programmed.  
To simplify internal bookkeeping, STARs end at the destination airport.  Most Stars end within a Tracon, so 
there is little need to have both a Star and an instrument approach in the same route in this simulation.  
Note – you may add a STAR or IAP to a route that did not have one originally, or change an existing STAR 
or IAP to a different one, or remove either by clearing direct to the airport.
Both a radio clearance and a field 10 update may end with a STAR or IAP.  The destination is automatically 
added.
Examples, current flight plan contains RBL and destination is RDD:
AM N1234X RTE FMG130025..SWR..RBL
AM N1234X 10  FMG130025..SWR.V494.SAC..RBL
AM N1234X RTE FMG130025..RBL.ILS34.RDD
AM N1234X RTE FMG130025..RBL.ILS34
Examples for the discussion in eATS.PDF, Departures, Changing the Route.
Initial direct to fix:
AM EJA1 RTE DNW.V465.TOCUD..JEKUG
Different SID, CID is 698:
AM 698  10  ALPIN3.KICNE..JEKUG
After surface wind change:
AM DAL1 10  RV1.UPP 
18 JUNE 2025 eATS Computer Commands Page  27