# Iron League

Iron League is an installable workout app for logging lifts, running training sprints, tracking ranks and comparing progress with friends.

The frontend in `web/` uses plain JavaScript and runs on the same origin as the [Personal Assistant relay](https://github.com/Ayoub-Mabkhout/personal-ai-assistant). The relay serves it at `/train/` and provides sign-in, workout sync, coach chat and notifications at `/train/api/`.

From a sibling checkout of Personal Assistant, install its server dependencies and start its local fixture:

```sh
python scripts/train_web_fixture.py --assets ../iron-league/web
```

Open one of the printed invite links. The fixture uses a temporary database with synthetic workouts and a stand-in coach. The frontend has no build step.

Onest is distributed under the [SIL Open Font License](Onest-OFL.txt).
