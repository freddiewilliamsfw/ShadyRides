# Shady Side of the Bus

Pick a London bus route, the stops you get on and off at, and a time. It tells you which side of the bus to sit on to stay out of direct sun, with a top-down view of the sun against the bus, a map of the journey, and a stretch-by-stretch breakdown.

**Live page:** https://freddiewilliamsfw.github.io/ShadyRides/

## How it works

- `index.html` is the whole app in one file, including the route data. There is no server and nothing to install.
- For each straight piece of the journey it compares the bus's heading with the sun's compass direction and height at that moment, then weighs up how much of the ride each side spends in the sun.
- It assumes a clear sky, open streets and an average speed of about 9 mph.

## Data

Route lines and stop lists are a snapshot of TfL open data (route lines from 24 October 2026, stop lists from 10 November 2026), so diversions and later route changes are not included.

Powered by TfL Open Data. Contains OS data © Crown copyright and database rights 2016 and Geomni UK Map data © and database rights 2019.

## Rebuilding

The pieces `index.html` is assembled from are in `src/`:

- `template.html` (markup and styles), `core.js` (sun maths and journey analysis), `ui.js` (the page)
- `data.json` (the compact route and stop data), built by `build_data.py` from TfL route geometry and stop sequences
- `cd src && python3 assemble.py` writes a fresh `index.html`

The earlier ShadyRides version of this page is still in the repository history, and its data and image files are left in place.
