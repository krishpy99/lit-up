- the logs are not correct. somehow logs are disappearing, filtering gives poor set of transactions that cannot be trusted. 
- tracked stuff should not be in logs, just the transactions of what happened
- for some reason in my hosted game, it keeps restarting the server. these are the logs:-
==> Deploying...
==> Setting WEB_CONCURRENCY=1 by default, based on available CPUs in the instance
==> Running 'npm start'
> lit-up@0.2.0 start
> npm run start -w server
> @lit-up/server@0.2.0 start
> node dist/index.js
       ___      _
      / __\___ | |_   _ ___  ___ _   _ ___
     / /  / _ \| | | | / __|/ _ \ | | / __|
    / /__| (_) | | |_| \__ \  __/ |_| \__ \
    \____/\___/|_|\__, |___/\___|\__,_|___/
                  |___/
     · Multiplayer Framework for Node.js ·
💖 Consider becoming a Sponsor on GitHub → https://github.com/sponsors/endel
🌟 Give us a star on GitHub → https://github.com/colyseus/colyseus
☁️  Deploy and scale your project on Colyseus Cloud → https://cloud.colyseus.io
[lit-up] Colyseus listening on :10000
[lit-up] Serving client from /opt/render/project/src/client/dist
==> Your service is live 🎉
==> 
==> ///////////////////////////////////////////////////////////
==> 
==> Available at your primary URL https://lit-up.onrender.com
==> 
==> ///////////////////////////////////////////////////////////
==> Detected service running on port 10000
==> Docs on specifying a port: https://render.com/docs/web-services#port-binding
==> Running 'npm start'
> lit-up@0.2.0 start
> npm run start -w server
> @lit-up/server@0.2.0 start
> node dist/index.js
       ___      _
      / __\___ | |_   _ ___  ___ _   _ ___
     / /  / _ \| | | | / __|/ _ \ | | / __|
    / /__| (_) | | |_| \__ \  __/ |_| \__ \
    \____/\___/|_|\__, |___/\___|\__,_|___/
                  |___/
     · Multiplayer Framework for Node.js ·
💖 Consider becoming a Sponsor on GitHub → https://github.com/sponsors/endel
🌟 Give us a star on GitHub → https://github.com/colyseus/colyseus
☁️  Deploy and scale your project on Colyseus Cloud → https://cloud.colyseus.io
[lit-up] Colyseus listening on :10000
[lit-up] Serving client from /opt/render/project/src/client/dist
> lit-up@0.2.0 start
> npm run start -w server
> @lit-up/server@0.2.0 start
> node dist/index.js
       ___      _
      / __\___ | |_   _ ___  ___ _   _ ___
     / /  / _ \| | | | / __|/ _ \ | | / __|
    / /__| (_) | | |_| \__ \  __/ |_| \__ \
    \____/\___/|_|\__, |___/\___|\__,_|___/
                  |___/
     · Multiplayer Framework for Node.js ·
💖 Consider becoming a Sponsor on GitHub → https://github.com/sponsors/endel
🌟 Give us a star on GitHub → https://github.com/colyseus/colyseus
☁️  Deploy and scale your project on Colyseus Cloud → https://cloud.colyseus.io
[lit-up] Colyseus listening on :10000
[lit-up] Serving client from /opt/render/project/src/client/dist
- we might also need a way to connect and reconnect people back to rooms. This might be a larger project. might take some planning.
