# sst-process-bench

Benchmark voor speech-to-text post-processing modellen. Je stuurt dezelfde transcript-cleaning prompt naar elk model en ziet welk model de regels echt volgt.

Dit is hoe je het draait:

```
node bench.mjs --provider groq --models llama-3.3-70b-versatile
```

## Wat je nodig hebt

Alleen Node 18 of nieuwer. Er is niets te installeren: geen `npm install`, geen dependencies. Check je versie met `node --version`.

Je hebt een API-key nodig van een provider naar keuze. De benchmark praat met elke OpenAI-compatible API.

## Snel starten

Zet je key als env-var (PowerShell):

```
$env:GROQ_API_KEY = "gsk-..."
node bench.mjs --provider groq --models llama-3.3-70b-versatile
```

Met OpenRouter:

```
$env:OPENROUTER_API_KEY = "sk-or-..."
node bench.mjs --provider openrouter --all
```

Op Linux/macOS gebruik je `export GROQ_API_KEY="gsk-..."` in plaats van `$env:`.

Wil je de key niet in je shell-geschiedenis, zet hem in een bestand en gebruik `--api-key-file key.txt`. Dat bestand staat in `.gitignore`, dus je commit het niet per ongeluk.

## Wat de benchmark test

Standaard draait hij 42 tests: 26 strikte tests plus een smoke-test voor 16 kerntalen. Elke strikte test controleert een of meer regels uit de prompt in `prompt.txt`:

- filler verwijderen (`um`, `ehm`, `zeg maar`)
- gesproken getallen omzetten (`vijf euro` naar `€5`, `ten percent` naar `10%`)
- gesproken operatoren (`plus` naar `+`, `keer` naar `*`)
- lijsten met bullets, e-mails netjes opmaken, adressen als `jan@voorbeeld.nl`
- `new line` en `nieuwe alinea` omzetten naar regeleinden
- gesproken leestekens en emoji (`fire emoji` naar 🔥)
- de Helium-regel: met een vensternaam als `Helium - voice notes` moet de output exact `NULL` zijn
- alleen de opgeschoonde tekst teruggeven, zonder markdown of uitleg

De smoke-test stuurt per taal een korte transcriptie met filler en checkt vier dingen: geen filler meer, geen code fences, niet leeg, geen crash of weigering. De volledige output per taal staat in `results.json`, zodat je zelf kunt beoordelen of de taal behouden bleef.

## Talen

De taallijst komt uit Handy (`cjpais/handy`, `src/lib/constants/languages.ts`). De standaardrun dekt en, nl, de, fr, es, it, pt, ja, zh-Hans, ar, ru, pl, tr, uk, cs en sv. Met `--all-langs` test je alle 100+ Handy-talen. Dat kost meer calls: 1 model x 128 tests.

## Handige commando's

Beschikbare modellen bekijken:

```
node bench.mjs --provider groq --list-models
```

Twee modellen vergelijken op Nederlands en Engels:

```
node bench.mjs --provider groq --models llama-3.3-70b-versatile,llama-3.1-8b-instant --lang nl,en
```

Alles testen bij OpenRouter (duur, elke gevonden model-id doet alle tests):

```
node bench.mjs --provider openrouter --all --all-langs
```

Eerst kijken wat een run zou doen, zonder API-calls:

```
node bench.mjs --provider groq --models llama-3.3-70b-versatile --dry-run
```

Checken of de scoring zelf klopt, zonder key:

```
node bench.mjs --self-test
```

## Alle opties

| Optie | Wat het doet |
|---|---|
| `--provider NAME` | `groq`, `openrouter`, `openai`, `cerebras`, `zai` of `custom`. Zonder vlag kiest hij de provider waarvoor een env-var staat, anders `groq`. |
| `--api-key XXX` | Key direct meegeven. Gaat voor op env-vars. |
| `--api-key-file F` | Key uit een bestand lezen. |
| `--base-url URL` | Eigen endpoint, bijvoorbeeld een lokale server. Combineer met `--provider custom`. |
| `--models a,b,c` | Welke modellen. Zonder vlag probeert hij `/models` en valt terug op bekende defaults. |
| `--all` | Alle modellen van `/models` testen. |
| `--list-models` | Modellen tonen en stoppen. |
| `--lang nl,en` | Alleen deze talen testen. |
| `--all-langs` | Alle Handy-talen testen. |
| `--deep-only` | Smoke-tests overslaan. |
| `--prompt-file F` | Eigen systeem-prompt gebruiken (default: `prompt.txt`). `${output}` wordt genegeerd, `${active_window}` wordt ingevuld. |
| `--active-window S` | Waarde voor `${active_window}` (default: `VS Code`). |
| `--concurrency N` | Aantal parallelle requests (default: 3). |
| `--timeout S` | Timeout per request in seconden (default: 60). |
| `--retries N` | Retries bij 429/5xx met backoff (default: 2). |
| `--out-json F` | JSON-resultaat (default: `results.json`). |
| `--out-md F` | Markdown-ranking (default: `results.md`). |
| `--no-out` | Niets wegschrijven. |
| `--verbose` | Toon elke model-output tijdens de run. |

## Hoe de score werkt

Per model zie je het percentage geslaagde tests, het aantal geslaagd/totaal, de gemiddelde latency en per categorie waar het fout ging. De ranking sorteert op score en bij gelijkspel op snelheid. Daarna volgt een score per taal over alle modellen heen, zodat je ziet welke talen achterblijven.

`results.json` bevat alles: metadata, timing, elke output en elke gefaalde check. `results.md` is de korte ranking voor in een PR of issue.

## Eigen prompt gebruiken

Standaard gebruikt de benchmark `prompt.txt`, exact de Handy-prompt met `${output}` en `${active_window}`. Handy stuurt de transcriptie als apart user-bericht, dus de benchmark doet dat ook. Met `--prompt-file` wijs je een eigen prompt aan; dezelfde `${...}`-regels gelden.

## Als iets misgaat

`Geen API-key`: zet de env-var voor je provider of gebruik `--api-key` of `--api-key-file`.

`GET /models faalt`: de benchmark valt terug op bekende model-namen. Werkt dat niet, geef expliciet `--models` op.

`HTTP 429`: je raakt een rate limit. Verlaag `--concurrency` naar 1 en verhoog `--retries`.

`HTTP 401`: je key klopt niet of hoort bij een andere provider. Check dat `--provider` past bij je key.

Timeouts bij trage modellen: verhoog `--timeout`, bijvoorbeeld `--timeout 120`.

## Bestanden

- `bench.mjs`: de benchmark zelf
- `prompt.txt`: de geteste systeem-prompt
- `langs.mjs`: Handy-talen en het kernset
- `cases.mjs`: strikte tests en smoke-teksten per taal
- `results.json` / `results.md`: output van je laatste run (genegeerd door git)
