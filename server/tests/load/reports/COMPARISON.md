
### Gradual ramp 10→200 req/s (read mix)

| run | reqs done | req/s | p50 | p95 | p99 | max | err % | dropped | srv CPU avg/peak (% of 1 core) | RSS peak MB | heap peak MB | evloop p99 max | Mongo conns | Mongo CPU avg % | Redis ops/s peak |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ramp | 10526 | 31.4 | 9.18 s | 47.91 s | 53.98 s | 56.24 s | 0.00 | 30774 | 25/52 | 777 | 515 | 26 ms | 105 | 1206 | 21 |
| ramp-idx | 41024 | 128.2 | 24 ms | 841 ms | 1.90 s | 3.14 s | 0.00 | 276 | 65/118 | 649 | 372 | 290 ms | 105 | 31 | 71 |
| ramp-after | 41299 | 129.1 | 9 ms | 41 ms | 75 ms | 246 ms | 0.00 | 0 | 58/104 | 562 | 317 | 27 ms | 43 | 29 | 72 |

### Stress: step to 2000 req/s target

| run | reqs done | req/s | p50 | p95 | p99 | max | err % | dropped | srv CPU avg/peak (% of 1 core) | RSS peak MB | heap peak MB | evloop p99 max | Mongo conns | Mongo CPU avg % | Redis ops/s peak |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| stress-idx | 59071 | 199.9 | 5.79 s | 31.57 s | 36.30 s | 36.95 s | 0.00 | 173053 | 103/137 | 1467 | 1157 | 257 ms | 105 | 32 | 82 |
| stress-after | 61200 | 207.6 | 5.67 s | 34.36 s | 35.54 s | 36.08 s | 0.00 | 170924 | 102/137 | 1443 | 1123 | 232 ms | 108 | 34 | 85 |

### Spike: 30→800→30 req/s

| run | reqs done | req/s | p50 | p95 | p99 | max | err % | dropped | srv CPU avg/peak (% of 1 core) | RSS peak MB | heap peak MB | evloop p99 max | Mongo conns | Mongo CPU avg % | Redis ops/s peak |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| spike-idx | 19981 | 99.5 | 6.45 s | 30.55 s | 38.03 s | 39.50 s | 0.83 | 39018 | 67/138 | 1469 | 1092 | 288 ms | 108 | 28 | 96 |
| spike-after | 21973 | 116.0 | 5.54 s | 25.51 s | 34.68 s | 35.23 s | 1.34 | 37026 | 67/141 | 1430 | 1083 | 197 ms | 108 | 27 | 85 |

### Login (bcrypt 12) 10 /s and 30 /s

| run | reqs done | req/s | p50 | p95 | p99 | max | err % | dropped | srv CPU avg/peak (% of 1 core) | RSS peak MB | heap peak MB | evloop p99 max | Mongo conns | Mongo CPU avg % | Redis ops/s peak |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| login10 | 601 | 10.0 | 219 ms | 225 ms | 235 ms | 348 ms | 0.00 | 0 | 216/230 | 401 | 129 | 27 ms | 20 | 1 | 10 |
| login10-after | 601 | 10.0 | 218 ms | 224 ms | 229 ms | 263 ms | 0.00 | 0 | 212/227 | 381 | 131 | 24 ms | 19 | 1 | 10 |
| login30 | 1457 | 18.3 | 10.29 s | 18.72 s | 19.48 s | 19.70 s | 0.00 | 344 | 399/424 | 397 | 227 | 24 ms | 19 | 2 | 9 |
| login30-after | 1456 | 18.3 | 10.21 s | 18.81 s | 19.56 s | 19.77 s | 0.00 | 345 | 400/413 | 397 | 228 | 25 ms | 19 | 4 | 10 |

### Realtime T1 (300 drivers / 1000 riders)

| run | sockets ok / conn errors | ping p50 | ping p95 | ping p99 | nearby searches ok | nearby timeouts | nearby p50 | nearby p95 | nearby p99 | Maps calls (stub) | events received | srv CPU avg/peak | RSS peak MB | Mongo CPU avg % | Redis ops/s peak |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ws-T1 | 1300 / 0 | 9.2 ms | 29 ms | 41 ms | 487 | 0 | 4.11 s | 5.89 s | 6.22 s | 31160 | 195839 | 27/63 | 406 | 18 | 2274 |
| ws-T1-after | 1300 / 0 | 10.4 ms | 29 ms | 42 ms | 508 | 0 | 624 ms | 725 ms | 749 ms | 26072 | 20895 | 27/43 | 416 | 19 | 2565 |

### Realtime T2 (1000 drivers / 3000 riders)

| run | sockets ok / conn errors | ping p50 | ping p95 | ping p99 | nearby searches ok | nearby timeouts | nearby p50 | nearby p95 | nearby p99 | Maps calls (stub) | events received | srv CPU avg/peak | RSS peak MB | Mongo CPU avg % | Redis ops/s peak |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ws-T2 | 4000 / 0 | 60.5 ms | 1.05 s | 3.26 s | 26 | 2038 | 3.82 s | 9.61 s | 9.72 s | 557440 | 2073945 | 97/121 | 1122 | 89 | 23148 |
| ws-T2-after | 4000 / 0 | 32.2 ms | 87 ms | 126 ms | 2138 | 0 | 2.22 s | 2.72 s | 3.12 s | 411798 | 81005 | 89/116 | 885 | 100 | 20188 |
