# The-Republic

Mobile-first online voting demo for a Web Technology project.
Frontend: HTML, CSS, vanilla JS. Backend: Node.js + Express.

## Run
```
npm install
npm start
```
Open http://localhost:3000

## Officer login (demo)
PIN: `1234`. Change it with an environment variable:
```
ADMIN_PIN=5678 npm start
```

## Parties
KJP (Kishore Janatha Party), KCP(M) (Kishore Communist Party (Marxist)), KNC (Kishore National Congress) + NOTA.

## API
| Method | Route | Who |
|---|---|---|
| GET | /api/status | public |
| POST | /api/verify | voter |
| GET | /api/receipt/:ref | public |
| POST | /api/vote | voter (one-time token) |
| GET | /api/results | public, after close only |
| POST | /api/admin/login | officer |
| GET | /api/admin/summary | officer |
| POST | /api/admin/start, /close, /reset | officer |
| POST, DELETE | /api/admin/candidates | officer |
| POST, DELETE | /api/admin/voters, /api/admin/voters/bulk | officer |

## Flow
1. Officer: add candidates, then **Start polling**.
2. Voter: verify, press the blue button on the ballot, confirm slip, cast vote.
3. Officer: **Close polling**. Results are now visible.

## Features
- Electoral roll: voters must match the roll exactly (EPIC + name + date of birth). Fake details are rejected. Officer adds voters one by one or uploads a CSV (see `sample-voters.csv`). The roll locks once polling starts and polling cannot start with an empty roll.
- Languages: English, Kannada, Hindi (toggle at top, remembered in browser)
- Vote reference number (e.g. `REP-4F9A-2C1B-77D0`) shown after voting. Random, not linked to voter or choice. Check it from the home screen.
- Polling countdown: officer sets minutes when starting polling; server auto-closes at zero (leave blank to close manually).

## ECI-based rules implemented
| Rule | Implementation |
|---|---|
| Voting age 18+ | DOB check |
| Valid EPIC (voter ID) | 3 letters + 7 digits |
| One person, one vote | Hashed EPIC stored, repeat blocked |
| Secret ballot | Voter list and vote tally stored separately |
| NOTA option | Always last on ballot |
| EVM-style ballot | Serial no., name, party, symbol, blue button |
| VVPAT-style confirmation | Slip shown before final cast |
| Vote is final | No change after casting |
| Candidate list frozen after polling starts | Admin controls locked |
| Max 15 candidates per EVM | Enforced |
| Unique symbols | Enforced |
| No result before counting | Results only after polling closes |
| Tie | Decided by draw of lots (message shown) |

## Not real
No Aadhaar/electoral-roll lookup. Data is saved in `data/election.json`, not a real database. For production you need a backend, a real electoral roll, authentication and audit logs.

## Deploy on GitHub Pages
Repo Settings > Pages > Deploy from branch `main` / root.
