/**
 * The bundled grammar.
 *
 * Shipped as a module rather than a data file so it loads identically in the
 * webview and in a bare Node test process — the user's override file is the
 * one that comes off disk.
 *
 * Every token here is either supplied by a Brief (and therefore true) or drawn
 * from a pool declared below (and therefore invented but harmless — a ship
 * name, a grumble, a shift number). A template that reaches for a token the
 * brief cannot supply is skipped, so the reported facts stay exact while the
 * texture stays varied.
 *
 * Notes on voice, since these lines are the product:
 *  - Radio procedure is clipped. People on a working channel do not speak in
 *    full sentences and they do not explain themselves.
 *  - Nobody comments on how remarkable space is. The commander lives here.
 *  - Complaints are specific. "They've knocked another 380 off" is a person;
 *    "prices are volatile" is a press release.
 *  - The commander is overhearing, not being addressed. Most of these people
 *    do not care that the commander exists, which is what makes the ones who
 *    do land.
 */

export const BUNDLED_GRAMMAR = String.raw`
# ---------------------------------------------------------------------------
# Pools — invented, harmless, and extendable by the user's own file.
# ---------------------------------------------------------------------------

@ShipNamePool
Iron Marlin
Cold Provenance
Sundowner
Ninth Wave
Tessellate
Bad Arithmetic
Long Story
Kestrel Rising
Overdraft
Quiet Professional
Salt and Iron
Ledger of Hours
Half a Nerve
Slow Freight
Marguerite
Dogwatch
Trellis
Perihelion
Second Thoughts
Ashgrove
Vantage
Copper Penny
Wandering Mote
Lares
Broken Compass
Errand Boy
Tallow Light
Fair Warning
Nine of Cups
Understudy
Blue Hour
Cargo Cult
Pale Horse
Reasonable Doubt

@GripePool
somebody has moved the loading schedule again
the refit paperwork came back for a third time
half the crew are still on ship time
that pad has been amber since the last rotation
the clamp diagnostics are lying to somebody
we have been waiting on a slot half the shift
the pad lift is running slow again
somebody parked a hauler across the service lane
the manifest office closed early, again
the fuel line on the east arm is down

@ShiftPool
first
second
third
night
back

@CrewNamePool
Vasquez
Okonjo
Halloran
Pruitt
Ito
Bekele
Ferreira
Nadel

# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# TOWER — traffic control talking to THIS ship, by name.
#
# The only channel that addresses the commander. Every line therefore uses
# <myship>, and the ones about a pad use <pad>, which is the number the game
# actually assigned rather than an invented one: a tower that clears you to a
# pad that does not exist is worse than a tower that says nothing.
#
# One-sided by design. The commander is a person at a keyboard, not a voice
# the app may put words into, so the tower transmits and does not wait for a
# reply it cannot hear.
# ---------------------------------------------------------------------------

TOWER texture
[control] <myship>, <station> tower. Docking granted, pad <pad>. Mind your approach speed.

TOWER texture
[control] <station> to <myship>, you are cleared to dock. Pad <pad>, and it is a tight one today.

TOWER texture
[control] <myship>, tower. Pad <pad> is yours. Watch the traffic on the way in.

TOWER texture
[control] <station> tower to <myship>. Pad <pad>, and mind the ship on your starboard side coming out.

TOWER texture
[control] <myship>, <station>. Clear of the slot, safe travels out there.

TOWER texture
[control] <station> tower, <myship>. You are away. Try not to be a stranger.

TOWER texture
[control] <myship>, tower. Departure logged. Lanes are your own problem now.

TOWER texture
[control] <station> to <myship>, request received. Stand by, we are working the queue.

TOWER texture
[control] Good to see you back, <myship>. Pad <pad> when you are ready, no rush.

TOWER texture
[control] <myship>, <station>. Pad <pad>, and welcome in. It has been a quiet shift.

TOWER texture
[control] Afternoon, <myship>. You have pad <pad>. Mind the crews working the far side.

TOWER texture
[control] <myship>, tower. Pad <pad> is clear for you. Safe hands today, by the look of it.

TOWER texture
[control] <myship>, that is you clear of us. Safe lanes, and come back when you like.

TOWER texture
[control] Off you go then, <myship>. <station> out — mind how you go.

# ---------------------------------------------------------------------------
# STATION — traffic control and station operations. Formal, clipped, busy.
# ---------------------------------------------------------------------------

STATION texture
[control] <station> control, all inbound hold your assigned vector. We are working the queue.

STATION texture
[control] <ShipNamePool>, <station>. You are drifting off the approach line.
[hauler] Correcting, <station>.

STATION texture
[control] <station> to <ShipNamePool>, your slot has moved. Stand by for reassignment.
[hauler] Standing by. Again.

STATION texture
[hauler] <station>, <ShipNamePool> requesting departure.
[control] Cleared. Mind the outbound lane, it is busy.

STATION establish (geography)
[hauler] <station>, <ShipNamePool> inbound from <origin>. Long haul.
[control] Copy, <ShipNamePool>. Join the queue, we will fit you in.

STATION establish (geography)
[control] All traffic, <station>. Approach control is running long today. Nobody is being singled out.
[hauler] Noted, <station>.

STATION establish
[control] <ShipNamePool>, <station>. <GripePool>, so expect a delay.
[hauler] Copy. It is always something.

STATION complicate (market)
[hauler] <station>, <ShipNamePool>. I am carrying <commodity> and I am told the price moved again.
[control] Not our department, <ShipNamePool>. Talk to the broker.

STATION complicate
[control] <ShipNamePool>, hold. We have a situation on the pad.
[hauler] Holding. How long?
[control] Longer than you want.

STATION reverse (market)
[control] <ShipNamePool>, <station>. Your buyer for <commodity> has withdrawn.
[hauler] Withdrawn.
[control] Their word, not mine. Pad is still yours.

STATION aftermath (event)
[control] All traffic, <station>. The outbound lane is clear again. Salvage teams are standing down.
[hauler] About time, <station>.

STATION aftermath
[control] <ShipNamePool>, <station>. You are cleared in. Sorry for the hold.
[hauler] Understood. Coming in.

STATION texture
[hauler] <station>, <ShipNamePool>, requesting docking.
[control] <ShipNamePool>, <station>. Clearance granted, pad is yours.

STATION texture
[hauler] <station> control, <ShipNamePool> on approach.
[control] We have you, <ShipNamePool>. Reduce to approach speed.

STATION texture
[control] <ShipNamePool>, you are cleared to land. Welcome to <station>.
[hauler] Much obliged, <station>.

STATION texture
[control] All traffic, <station>. Mind the no-fire zone. We are not asking twice.

STATION texture
[control] <ShipNamePool>, <station>. Your loitering time is up. Move or be moved.
[hauler] Moving, <station>. Keep your voice down.

STATION texture
[hauler] <station>, <ShipNamePool>, request refuel and repair on arrival.
[control] Logged, <ShipNamePool>. Services will meet you at the pad.

STATION texture
[control] <station> to all inbound: the mail run has priority for the next rotation.
[hauler] Copy, <station>. Story of my life.

STATION texture
[control] <ShipNamePool>, security wants your manifest before you unload.
[hauler] It is filed, <station>. It has always been filed.

STATION texture
[hauler] <station>, <ShipNamePool>. Clear of the mailslot, thanks for the turnaround.
[control] Safe flying, <ShipNamePool>.

STATION texture
[control] <ShipNamePool>, you are drifting into the outbound lane. Correct now.
[hauler] Correcting.

STATION texture
[control] All traffic, <station>. Expect delays. <GripePool>.
[hauler] Every single time.

STATION texture
[hauler] <station>, is there anybody actually on this frequency?
[control] There is now, <ShipNamePool>. State your business.

STATION establish (geography)
[control] <ShipNamePool>, <station>. You are a long way from <origin>.
[hauler] You have no idea, <station>.

STATION establish (geography)
[hauler] <station>, <ShipNamePool>, inbound. Anything I should know before I commit?
[control] Traffic is heavy and the lifts are slow. Otherwise, no.

# ---------------------------------------------------------------------------
# LOCAL — ship to ship on the open channel. Nobody is on duty here.
# ---------------------------------------------------------------------------

LOCAL texture
[hauler] Anybody actually running the <ShipNamePool> or is that transponder borrowed?
[hauler2] Borrowed. Do not make it a thing.

LOCAL texture
[hauler] Open channel, this is <ShipNamePool>. Anyone got a working read on the queue?
[hauler2] Same as an hour ago. Nothing.

LOCAL texture
[hauler] <ShipNamePool> here. <GripePool>.
[hauler2] You are not alone in that.

LOCAL texture
[miner] <ShipNamePool>, coming off shift. Somebody else can have the good rock.
[hauler2] Generous of you.

LOCAL establish (geography)
[hauler] <ShipNamePool>, just in from <origin>. What did I miss?
[hauler2] Nothing. That is the news.

LOCAL establish (market)
[trader] Anyone moving <commodity> through here?
[hauler2] Not at that price, no.

LOCAL complicate (market)
[trader] <ShipNamePool>. They have taken <price> off <commodity> at <station> since last week.
[hauler2] Third time this month. Somebody is playing with it.

LOCAL complicate (faction)
[hauler] Word is <faction> is throwing weight around again.
[hauler2] They are at <influence> percent. They can afford to.

LOCAL reverse (market)
[trader] Scratch what I said about <commodity>. It has turned.
[hauler2] Turned which way?
[trader] The way that helps me and not you.

LOCAL reverse (faction)
[hauler] <faction> just went <state>.
[hauler2] Then the work here changes tomorrow. It always does.

LOCAL aftermath (event)
[hauler] Whatever went off out there, it is finished.
[hauler2] Somebody is having a very bad day, then.

LOCAL aftermath (event)
[patrol] Open channel, area is clear. Traffic may resume normal routing.
[hauler2] Copy, thanks.

# ---------------------------------------------------------------------------
# CREW — your own people. Barely processed, close, familiar.
# ---------------------------------------------------------------------------

CREW texture
[crew:engineering] Power draw is settled. I would like it on record that I said it would be.
[crew:ops] It is on record. It is always on record.

CREW texture
[crew:helm] We are holding station.
[crew:science] I can see that.
[crew:helm] I was being sociable.

CREW texture
[crew:ops] <CrewNamePool> has the <ShiftPool> watch.
[crew:engineering] Then I am going to sleep.

CREW texture
[crew:comms] Traffic is light on the open channel.
[crew:ops] Light is fine. Light is restful.

CREW establish (geography)
[crew:helm] Plot is in for <system>.
[crew:ops] How long?
[crew:helm] Long enough to eat something.

CREW establish
[crew:engineering] I want to look at the port coupling before we do anything clever.
[crew:ops] Define clever.
[crew:engineering] Anything you were about to suggest.

CREW complicate
[crew:engineering] That reading is drifting again.
[crew:science] Drifting how?
[crew:engineering] The way things drift right before I have to fix them.

CREW complicate (event)
[crew:comms] We are being talked about on the local channel.
[crew:ops] Favourably?
[crew:comms] Talked about.

CREW reverse
[crew:engineering] I found it.
[crew:ops] Found what?
[crew:engineering] The thing I have been complaining about for two days. It was my fault.

CREW aftermath (event)
[crew:ops] Everyone is accounted for.
[crew:engineering] Then I will start the list of what is not.

CREW aftermath (event)
[crew:comms] It has gone quiet again.
[crew:science] Quiet is a measurement, not a promise.

# ---------------------------------------------------------------------------
# DEEP — long range, degraded, mostly the absence of anyone.
# ---------------------------------------------------------------------------

DEEP texture
[crew:comms] Carrier tone only. Nothing riding on it.
[crew:science] Then nobody is out here but us.

DEEP texture
[crew:comms] I keep the receiver open out of habit.
[crew:ops] Keep it open.

DEEP texture
[crew:science] Long range is clean. Cleaner than I would like.

DEEP establish (geography)
[crew:comms] Last relay was <origin>. We are past its reach now.
[crew:ops] Understood. We are on our own timing.

DEEP complicate
[crew:comms] Something touched the receiver. Two seconds, then nothing.
[crew:science] Log it. Do not chase it.

DEEP aftermath (event)
[crew:comms] Whatever that was, it is not repeating.
[crew:ops] Good.

# ---------------------------------------------------------------------------
# EMERGENCY — only ever fired from a verified brief. Hot, short, real.
# ---------------------------------------------------------------------------

EMERGENCY establish (event)
[distress] Any vessel, any vessel. <ShipNamePool> declaring an emergency.

EMERGENCY complicate (event)
[distress] <ShipNamePool>, we are losing the main bus. Requesting immediate assistance.
[control] <ShipNamePool>, <station>. We have you. Hold on.

EMERGENCY aftermath (event)
[control] All traffic, the emergency is resolved. Normal operations resume.

EMERGENCY reverse (event)
[distress] Belay the emergency call. <ShipNamePool> is under control.
[control] Copy, <ShipNamePool>. Do not do that to us again.

# ---------------------------------------------------------------------------
# CARRIER — big ship, good transmitter, slow to key. A surprise, not a rotation.
# ---------------------------------------------------------------------------

CARRIER texture
[carrier] All craft in the vicinity, this is <carrierName>. Docking access is open to visiting traffic.

CARRIER texture
[carrier] <carrierName> to local traffic. Our services are open. Our patience is finite.

CARRIER establish (geography)
[carrier] <carrierName>, holding in <system>. We will be here a while.

CARRIER complicate
[carrier] <carrierName> to local traffic. We are preparing for departure. Clear the approach.
[hauler] Copy, <carrierName>. Moving.

CARRIER aftermath (event)
[carrier] <carrierName> to local traffic. Whatever just happened out there, our bays are open if anyone needs them.

# ---------------------------------------------------------------------------
# CONCOURSE — a PA in a room you are standing in. Not radio at all.
# ---------------------------------------------------------------------------

CONCOURSE texture
[pa] Attention concourse. The <ShiftPool> shift rotation begins shortly.

CONCOURSE texture
[pa] Attention concourse. <GripePool>. We appreciate your patience.

CONCOURSE texture
[pa] Would the owner of an unattended cargo container please report to the service desk.

CONCOURSE establish (geography)
[pa] Welcome to <station>. Please observe local ordinance while on the concourse.

CONCOURSE complicate (market)
[pa] Trader advisory. <commodity> pricing at <station> has been revised. Brokers are updating terminals now.

CONCOURSE complicate (construction)
[pa] Contract notice. <site> is still short of <commodity>. Haulage rates have been reviewed upward.

CONCOURSE aftermath (event)
[pa] Attention concourse. Medical teams are standing down. Normal service resumes.

CONCOURSE texture
[pa] The observation deck is closed to the public for the remainder of the <ShiftPool> shift.

LOCAL texture
[hauler] Anyone else getting interference on this band, or is it just me?
[hauler2] Just you. Check your antenna before you blame the galaxy.

LOCAL texture
[hauler] Long shift.
[hauler2] Long shift.

LOCAL texture
[miner] Rock out here is thin. I have seen better in a gravel pit.
[hauler2] You say that every rotation.

LOCAL texture
[hauler] <ShipNamePool>, anybody know if the pads are moving at all?
[hauler2] Define moving.

LOCAL texture
[trader] Somebody tell me why I do this for a living.
[hauler2] Because you are extremely bad at everything else.

LOCAL texture
[hauler] Open channel: does anyone actually read the safety bulletins?
[hauler2] Somebody must. They keep writing them.

LOCAL texture
[patrol] Routine sweep, all vessels. Keep your transponders honest.
[hauler2] Always, officer.

LOCAL texture
[hauler] That is a lot of traffic for a system this size.
[hauler2] Something is paying well. It never lasts.

LOCAL texture
[miner] Coming off a double. If anybody needs me I am asleep.
[hauler2] Noted. Nobody needs you.

LOCAL texture
[hauler] <ShipNamePool> to whoever is sitting on the entry lane. Move.
[hauler2] Say please.
[hauler] No.

CREW texture
[crew:helm] Nothing on the scopes.
[crew:ops] Good. Keep it that way.

CREW texture
[crew:engineering] Somebody has been resetting my alarms.
[crew:helm] Somebody has been setting too many alarms.

CREW texture
[crew:science] I have been staring at the same readout for an hour.
[crew:comms] Has it changed?
[crew:science] No. That is the finding.

CREW texture
[crew:ops] Hold is secure. Straps checked twice.
[crew:engineering] Twice is once more than usual.

CREW texture
[crew:comms] Coffee is gone.
[crew:ops] All of it?
[crew:comms] All of it.

CREW texture
[crew:helm] We are running slightly ahead.
[crew:ops] Do not say that out loud.

CREW texture
[crew:engineering] <CrewNamePool> fixed the vent. Properly, this time.
[crew:ops] I will believe it when it is quiet.

CONCOURSE texture
[pa] Attention concourse. Please do not leave luggage on the transit floor.

CONCOURSE texture
[pa] The medical bay reminds passengers that low gravity is not an excuse.

CONCOURSE texture
[pa] Would the pilot of the vessel on the amber pad please contact traffic control.

CONCOURSE texture
[pa] Attention concourse. <GripePool>. We thank you for your understanding.

CONCOURSE texture
[pa] Passengers are reminded that the lower ring is crew access only.

CONCOURSE texture
[pa] Last call for the outbound transit. It will not wait.


# ---------------------------------------------------------------------------
# Second pass. Measured: only 53 of the first 95 templates are REACHABLE when
# docked in an ordinary system — the rest need to be on foot, or a carrier, or
# real isolation. At ninety transmissions an hour that worked out at 1.7 plays
# per line per hour, which is audible as repetition however well the selection
# spreads them. So the channels that are always open get the most material.
# ---------------------------------------------------------------------------

STATION texture
[control] <ShipNamePool>, hold at the marker. We have an outbound on your vector.
[hauler] Holding.

STATION texture
[control] <station> to the vessel loitering on pad approach: you are not invisible.
[hauler] Never claimed to be.

STATION texture
[hauler] <station>, <ShipNamePool>. Any chance of a pad closer than the last one?
[control] There is always a chance, <ShipNamePool>. Today is not it.

STATION texture
[control] All traffic, customs is running spot checks this rotation. Have your manifests ready.
[hauler] Understood, <station>.

STATION texture
[control] <ShipNamePool>, your transponder is reading intermittent. Get it looked at.
[hauler] It is on the list, <station>.

STATION texture
[hauler] <station>, <ShipNamePool>, docked and secure. Thanks for the guidance.
[control] Any time. Try not to hit anything on the way out.

STATION texture
[control] <station> advisory: the east arm lifts are out. Allow extra time to the concourse.
[hauler] Noted. Again.

STATION texture
[control] <ShipNamePool>, we have a medical transport inbound. Give way and hold.
[hauler] Giving way. Hope they make it.

STATION texture
[hauler] <station>, who do I talk to about a damaged cargo seal?
[control] Services desk, level two. Bring the manifest and your patience.

STATION texture
[control] Attention all traffic: <station> is at capacity. Inbound vessels will be queued.
[hauler] Wonderful.

STATION texture
[control] <ShipNamePool>, that is not your assigned pad.
[hauler] It was empty.
[control] It was assigned. Move.

STATION texture
[hauler] <station>, <ShipNamePool> requesting departure clearance.
[control] Cleared, <ShipNamePool>. Mind the traffic, it is thick out there.

STATION texture
[control] <station> to all vessels: fuel services are running at reduced capacity.
[hauler] Any estimate?
[control] None I would repeat on an open channel.

STATION texture
[control] <ShipNamePool>, welcome back. That was quick.
[hauler] It went badly, <station>.

STATION texture
[hauler] <station>, I am showing a discrepancy on my landing fee.
[control] Take it up with accounts. I fly ships in, I do not do sums.

STATION texture
[control] All traffic, mind your approach speed. We have had two incidents this rotation.
[hauler] Copy, <station>. Two is a lot.

STATION texture
[control] <ShipNamePool>, security would like a word about your last visit.
[hauler] I am sure it is a misunderstanding.
[control] They usually are.

STATION texture
[hauler] <station>, <ShipNamePool>. Requesting a berth with lift access.
[control] Noted, <ShipNamePool>. No promises.

STATION establish (geography)
[control] <ShipNamePool>, <station>. Confirm you are the one routed from <origin>?
[hauler] That is us, <station>. Long way round.

STATION establish (geography)
[hauler] <station>, first time in <system>. Anything I should avoid?
[control] The obvious things. And the outbound lane at shift change.

# ---------------------------------------------------------------------------

LOCAL texture
[hauler] Anybody had trouble with the fuel scoop on the newer hulls?
[hauler2] Constantly. You get used to babysitting it.

LOCAL texture
[trader] The margins on this run are a joke.
[hauler2] Then stop flying it.
[trader] I will. Next week. Definitely.

LOCAL texture
[hauler] Who is running dark on the edge of the lane?
[hauler2] Nobody friendly. Give it room.

LOCAL texture
[miner] Third rock in a row with nothing in it.
[hauler2] That is not bad luck, that is a bad ring.

LOCAL texture
[hauler] Does anybody else talk to their ship?
[hauler2] Only when it talks first.

LOCAL texture
[trader] I have been awake for longer than is sensible.
[hauler2] Then park it. The cargo will still be cargo tomorrow.

LOCAL texture
[hauler] Open channel: anyone got a spare limpet controller they are not attached to?
[hauler2] Attached is a strong word. Make me an offer.

LOCAL texture
[patrol] All vessels, keep clear of the wreckage on the outbound lane.
[hauler2] What wreckage?
[patrol] Exactly.

LOCAL texture
[hauler] I swear this route was shorter last month.
[hauler2] The route is the same. You are older.

LOCAL texture
[miner] Somebody has been working my ring.
[hauler2] It is not your ring.
[miner] It is now.

LOCAL texture
[hauler] Nice bit of flying, whoever that was on the approach.
[hauler2] Pure luck. Do not tell anyone.

LOCAL texture
[trader] Anyone know if the yard here does hull work?
[hauler2] They do. Slowly, and they will notice every scratch.

LOCAL texture
[hauler] This is the quietest I have heard this system.
[hauler2] Enjoy it. It never holds.

LOCAL texture
[hauler] <ShipNamePool>, are you the one who cut across my approach?
[hauler2] Could have been anyone.
[hauler] It was you.

LOCAL texture
[patrol] Routine broadcast: report anything unusual on this frequency.
[hauler2] Define unusual, officer. It has been a strange week.

LOCAL texture
[trader] Somebody undercut me by a hundred and I want names.
[hauler2] You would do the same.
[trader] I would. That is not the point.

LOCAL establish (geography)
[hauler] Just dropped in from <origin>. Is it always like this here?
[hauler2] Worse, usually. You caught a good day.

LOCAL establish (geography)
[trader] Anyone running out toward <origin> with room to spare?
[hauler2] Not this rotation. Ask around the concourse.

# ---------------------------------------------------------------------------

CREW texture
[crew:engineering] The starboard thruster is within tolerance.
[crew:ops] Within tolerance, or within your tolerance?
[crew:engineering] There is no meaningful difference.

CREW texture
[crew:helm] Approach is clean.
[crew:ops] Say that again after we are down.

CREW texture
[crew:science] I ran the numbers twice.
[crew:ops] And?
[crew:science] And I would like to run them a third time.

CREW texture
[crew:comms] Somebody on the local channel is asking about us.
[crew:ops] Asking what?
[crew:comms] Nothing worth answering.

CREW texture
[crew:engineering] I have logged the vibration. Again.
[crew:helm] It is a feature at this point.

CREW texture
[crew:ops] Manifest is signed off.
[crew:engineering] By whom?
[crew:ops] By me. Do not make it complicated.

CREW texture
[crew:helm] We have been in this seat too long.
[crew:science] Speak for yourself. I like the seat.

CREW texture
[crew:comms] Quiet band tonight.
[crew:helm] Good. I have had enough conversation.

CREW texture
[crew:engineering] If anybody touches the coolant settings I will know.
[crew:ops] Nobody is touching anything.

CREW texture
[crew:science] There is a smell.
[crew:engineering] There is always a smell. Is it a new one?
[crew:science] It is a new one.

CREW texture
[crew:ops] <CrewNamePool> is off shift and I am not waking them.
[crew:helm] Wise.

CREW texture
[crew:helm] Docking computer is doing that thing again.
[crew:engineering] Then fly it yourself. That is what the stick is for.

CREW texture
[crew:comms] Message traffic is up. Nothing addressed to us.
[crew:ops] The best kind.

CREW texture
[crew:engineering] Everything is nominal, and I resent how suspicious that makes me.
[crew:science] That is the correct posture.

CREW texture
[crew:ops] Rations check: we are fine for another rotation.
[crew:helm] Define fine.
[crew:ops] We will not starve. That is the definition.

CREW establish (geography)
[crew:helm] We are clear of <system>.
[crew:ops] Log it and get some rest.

CREW establish
[crew:engineering] I want an hour with the power distributor before we do anything demanding.
[crew:ops] You have forty minutes.
[crew:engineering] Then I will do forty minutes of complaining.

`;
