---
name: travel
description: Search and book flights and hotels. Use when the owner mentions a trip, a flight, a hotel, a check-in, or wants travel options compared. Search on the desktop browser, compare two or three options with full totals, never book without approval, set check-in reminders with schedules, and use a takeover for logins, loyalty numbers and payment.
---

# Travel

Travel is where mistakes cost real money. Slow down, show totals, and ask
before every booking. `travel.book` is in `neverWithoutAsk` by default even for
the owner.

## Gather

Dates (fixed or flexible), origin and destination, number of travellers, cabin
or hotel class, budget, loyalty programmes, and constraints from memory (aisle
seat, no red-eyes, hotel near the venue). Ask for what is missing, one question
per text. Save new preferences with `memory_write`.

## Search

Use the desktop (skill `maritime-computer`). Flights: Google Flights
(google.com/travel/flights) for the overview, then the airline's own site for
the fare and bags. Hotels: Google Hotels for the overview, then the hotel's own
site and one aggregator for price. `web_search` is fine for background (visa
rules, airport transfer time) but prices come from the booking pages.

Without a desktop, Google Flights, Skyscanner and Kayak cannot be read:
`browse_page` gets an empty result list from them, so do not spend its small
quota there. If `search_flights` is available, use it for live fares. If
not, say you cannot see live prices, do not guess fares, and send the owner the
Google Flights link for their dates:
`https://www.google.com/travel/flights?q=Flights%20from%20LON%20to%20HEL%20on%202026-10-25%20through%202026-10-27`
(airport or city codes, ISO dates; drop "through ..." for one-way).
`browse_page` is still useful for hotel pages and fare rules. You can search,
compare and recommend without a desktop, but booking needs it.

For each option record: carrier or property, times or dates, duration and stops,
fare class, what is included (bags, seat, breakfast, cancellation), and the
total with taxes and fees. Zoom on the total; sites hide fees until late.

## Compare

Text 2 or 3 options in one message. Lead with the total. Say the trade-off in a
phrase. Recommend one and say why in one sentence.

Agent: Three options for Boston to SFO, Oct 20 to 24. JetBlue nonstop out 7:10am
back 4:30pm, $412 total with a carry-on. United nonstop out 9am back 6pm, $468,
checked bag included. Delta one stop, $355 but adds three hours each way. I'd
take JetBlue. Want me to book it?

## Book

1. `ask_owner` with the exact itinerary and total: "Book JetBlue BOS-SFO Oct 20
   7:10am, return Oct 24 4:30pm, 1 adult, $412 total? Go ahead?" Wait.
2. On yes, fill passenger details from memory only if the owner has stored
   them there and told you to use them. Dates of birth, passport numbers and
   loyalty numbers that live in the Vault are entered by the owner during a
   `request_takeover`; never ask the owner to text them to you.
3. At the payment step, call `request_takeover` with reason "Enter payment for
   JetBlue BOS-SFO $412". If the takeover returns `success: false`, stop and
   tell the owner. Do not retry.
4. Read the confirmation page. Zoom on the record locator, dates and total.
   Save a screenshot to the workspace (`workspace/travel/<trip>/confirmation.png`).

## After booking

- Calendar: create events for each flight (departure to arrival, airport
  terminals in the location) and the hotel stay. Include the record locator.
- `schedule_create` a one-shot reminder 24 hours before each departure with the
  prompt "Check in for JetBlue BOS-SFO Oct 20, locator ABC123, then text the
  owner the boarding pass status." Online check-in itself happens when that
  fires, again through the desktop, with a takeover if the site needs a login.
- `journal_append` the booking. The approval you got records the spend in the
  audit; mention merchant and total in the journal line too.
- Text the owner: what was booked, total, locator, and that reminders are set.

## Changes and cancellations

Find the fare rules first (airline site, "manage booking"). Tell the owner the
fee and the refund form (cash, credit). Change only after a yes. Cancellation
within 24 hours of purchase is often free in the US; mention it when relevant.

## Do not

- Do not book without an explicit yes for this exact itinerary and total.
- Do not enter card numbers, passport numbers or loyalty logins yourself.
- Do not quote a fare without the total including taxes and the bag you know
  the owner needs.
- Do not hold two bookings for the same trip.
