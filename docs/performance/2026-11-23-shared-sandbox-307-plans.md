# Claim plans before and after #307 (PostgreSQL 17, MySQL 8.4)

Lower bound, shared sandbox (not dedicated). PostgreSQL: auto_explain (ANALYZE, BUFFERS) of the claim statements of the first claims after seeding 20,000 queued and 20,000 finished jobs (`pnpm load:depth`; a dedicated phase with one session, no other worker running). Statement texts are left out; they are in `packages/db/src/prisma-repositories.ts`. MySQL: EXPLAIN ANALYZE by hand on a table of 20,000 queued and 20,000 finished jobs, 200 keys, with the same claim index.

## PostgreSQL, main (GROUP BY over every queued job), 20 keys, 20,000 queued

```
duration: 0.069 ms  plan:
	GroupAggregate  (cost=6.20..6.22 rows=1 width=14) (actual time=0.067..0.067 rows=0 loops=1)
	  Group Key: "apiKeyId"
	  Buffers: shared hit=5
	  ->  Sort  (cost=6.20..6.20 rows=1 width=6) (actual time=0.065..0.066 rows=0 loops=1)
	        Sort Key: "apiKeyId"
	        Sort Method: quicksort  Memory: 25kB
	        Buffers: shared hit=5
	        ->  Index Scan using "Job_workspaceId_queue_status_priority_createdAt_idx" on "Job"  (cost=0.41..6.19 rows=1 width=6) (actual time=0.023..0.023 rows=0 loops=1)
	              Index Cond: (("workspaceId" = 'default'::text) AND (queue = 'database'::text) AND (status = 'running'::text))
	              Filter: (("leaseExpiresAt" IS NOT NULL) AND ("apiKeyId" IS NOT NULL))
	              Buffers: shared hit=5

duration: 17.514 ms  plan:
	HashAggregate  (cost=1609.79..1610.39 rows=60 width=18) (actual time=17.462..17.477 rows=61 loops=1)
	  Group Key: "apiKeyId", priority
	  Batches: 1  Memory Usage: 24kB
	  Buffers: shared hit=403
	  ->  Bitmap Heap Scan on "Job"  (cost=227.84..1459.26 rows=20071 width=18) (actual time=0.663..11.194 rows=19998 loops=1)
	        Recheck Cond: (status = 'queued'::text)
	        Filter: ((type = ANY ('{render,preview}'::text[])) AND ("workspaceId" = 'default'::text) AND (queue = 'database'::text))
	        Heap Blocks: exact=386
	        Buffers: shared hit=403
	        ->  Bitmap Index Scan on "Job_status_leaseExpiresAt_idx"  (cost=0.00..222.82 rows=20071 width=0) (actual time=0.601..0.601 rows=20000 loops=1)
	              Index Cond: (status = 'queued'::text)
	              Buffers: shared hit=17

duration: 2.358 ms  plan:
	Limit  (cost=22.29..43.84 rows=1 width=37) (actual time=2.352..2.353 rows=1 loops=1)
	  Buffers: shared hit=649
	  ->  LockRows  (cost=22.29..1315.57 rows=60 width=37) (actual time=2.351..2.351 rows=1 loops=1)
	        Buffers: shared hit=649
	        ->  Incremental Sort  (cost=22.29..1314.97 rows=60 width=37) (actual time=2.330..2.330 rows=1 loops=1)
	              Sort Key: "createdAt", id
	              Presorted Key: "createdAt"
	              Full-sort Groups: 1  Sort Method: quicksort  Average Memory: 26kB  Peak Memory: 26kB
	              Buffers: shared hit=648
	              ->  Index Scan using "Job_workspaceId_apiKeyId_createdAt_idx" on "Job"  (cost=0.41..1312.27 rows=60 width=37) (actual time=1.921..2.309 rows=33 loops=1)
	                    Index Cond: (("workspaceId" = 'default'::text) AND ("apiKeyId" = 'key_15'::text))
	                    Filter: ((type = ANY ('{render,preview}'::text[])) AND (queue = 'database'::text) AND (status = 'queued'::text) AND (priority = 0))
	                    Rows Removed by Filter: 898
	                    Buffers: shared hit=648

```

## PostgreSQL, this change (skip scan, taken because 20,000 queued > 32 x 60 pairs), 20 keys, 20,000 queued

```
duration: 1.189 ms  plan:
	Hash Left Join  (cost=304.16..309.75 rows=202 width=52) (actual time=0.050..1.162 rows=61 loops=1)
	  Hash Cond: (g.k = r.k)
	  Buffers: shared hit=291
	  CTE g
	    ->  Recursive Union  (cost=0.41..77.00 rows=101 width=18) (actual time=0.030..1.077 rows=60 loops=1)
	          Buffers: shared hit=279
	          ->  Limit  (cost=0.41..0.58 rows=1 width=18) (actual time=0.028..0.028 rows=1 loops=1)
	                Buffers: shared hit=5
	                ->  Index Scan using "Job_claim_idx" on "Job" j  (cost=0.41..3253.53 rows=19668 width=18) (actual time=0.027..0.027 rows=1 loops=1)
	                      Index Cond: (("workspaceId" = 'default'::text) AND (queue = 'database'::text) AND (status = 'queued'::text) AND ("apiKeyId" IS NOT NULL))
	                      Filter: (type = ANY ('{render,preview}'::text[]))
	                      Buffers: shared hit=5
	          ->  Nested Loop  (cost=0.41..7.54 rows=10 width=18) (actual time=0.017..0.017 rows=1 loops=60)
	                Buffers: shared hit=274
	                ->  WorkTable Scan on g g_1  (cost=0.00..0.20 rows=10 width=36) (actual time=0.000..0.000 rows=1 loops=60)
	                ->  Limit  (cost=0.41..0.72 rows=1 width=18) (actual time=0.016..0.016 rows=1 loops=60)
	                      Buffers: shared hit=274
	                      ->  Index Scan using "Job_claim_idx" on "Job" j_1  (cost=0.41..2068.82 rows=6692 width=18) (actual time=0.016..0.016 rows=1 loops=60)
	                            Index Cond: (("workspaceId" = 'default'::text) AND (queue = 'database'::text) AND (status = 'queued'::text) AND (ROW("apiKeyId", priority) > ROW(g_1.k, g_1.p)))
	                            Filter: (type = ANY ('{render,preview}'::text[]))
	                            Buffers: shared hit=274
	  CTE h
	    ->  Recursive Union  (cost=0.41..220.93 rows=101 width=18) (actual time=0.014..0.021 rows=1 loops=1)
	          Buffers: shared hit=7
	          ->  Limit  (cost=0.41..1.92 rows=1 width=18) (actual time=0.013..0.014 rows=1 loops=1)
	                Buffers: shared hit=4
	                ->  Index Scan using "Job_claim_idx" on "Job" j_2  (cost=0.41..616.38 rows=408 width=18) (actual time=0.013..0.013 rows=1 loops=1)
	                      Index Cond: (("workspaceId" = 'default'::text) AND (queue = 'database'::text) AND (status = 'queued'::text) AND ("apiKeyId" IS NULL))
	                      Filter: (type = ANY ('{render,preview}'::text[]))
	                      Buffers: shared hit=4
	          ->  Nested Loop  (cost=0.41..21.80 rows=10 width=18) (actual time=0.006..0.007 rows=0 loops=1)
	                Buffers: shared hit=3
	                ->  WorkTable Scan on h h_1  (cost=0.00..0.20 rows=10 width=4) (actual time=0.001..0.001 rows=1 loops=1)
	                ->  Limit  (cost=0.41..2.15 rows=1 width=18) (actual time=0.005..0.005 rows=0 loops=1)
	                      Buffers: shared hit=3
	                      ->  Index Scan using "Job_claim_idx" on "Job" j_3  (cost=0.41..236.37 rows=136 width=18) (actual time=0.004..0.004 rows=0 loops=1)
	                            Index Cond: (("workspaceId" = 'default'::text) AND (queue = 'database'::text) AND (status = 'queued'::text) AND ("apiKeyId" IS NULL) AND (priority > h_1.p))
	                            Filter: (type = ANY ('{render,preview}'::text[]))
	                            Buffers: shared hit=3
	  ->  Append  (cost=0.00..5.05 rows=202 width=44) (actual time=0.031..1.124 rows=61 loops=1)
	        Buffers: shared hit=286
	        ->  CTE Scan on g  (cost=0.00..2.02 rows=101 width=44) (actual time=0.031..1.094 rows=60 loops=1)
	              Buffers: shared hit=279
	        ->  CTE Scan on h  (cost=0.00..2.02 rows=101 width=44) (actual time=0.014..0.021 rows=1 loops=1)
	              Buffers: shared hit=7
	  ->  Hash  (cost=6.21..6.21 rows=1 width=14) (actual time=0.014..0.015 rows=0 loops=1)
	        Buckets: 1024  Batches: 1  Memory Usage: 8kB
	        Buffers: shared hit=5
	        ->  Subquery Scan on r  (cost=0.41..6.21 rows=1 width=14) (actual time=0.014..0.014 rows=0 loops=1)
	              Buffers: shared hit=5
	              ->  GroupAggregate  (cost=0.41..6.21 rows=1 width=14) (actual time=0.014..0.014 rows=0 loops=1)
	                    Group Key: r_1."apiKeyId"
	                    Buffers: shared hit=5
	                    ->  Index Scan using "Job_claim_idx" on "Job" r_1  (cost=0.41..6.19 rows=1 width=6) (actual time=0.013..0.013 rows=0 loops=1)
	                          Index Cond: (("workspaceId" = 'default'::text) AND (queue = 'database'::text) AND (status = 'running'::text) AND ("apiKeyId" IS NOT NULL))
	                          Filter: ("leaseExpiresAt" IS NOT NULL)
	                          Buffers: shared hit=5

duration: 0.114 ms  plan:
	Limit  (cost=2.26..4.12 rows=1 width=37) (actual time=0.111..0.112 rows=1 loops=1)
	  Buffers: shared hit=32
	  ->  LockRows  (cost=2.26..111.99 rows=59 width=37) (actual time=0.110..0.111 rows=1 loops=1)
	        Buffers: shared hit=32
	        ->  Incremental Sort  (cost=2.26..111.40 rows=59 width=37) (actual time=0.103..0.104 rows=1 loops=1)
	              Sort Key: "createdAt", id
	              Presorted Key: "createdAt"
	              Full-sort Groups: 1  Sort Method: quicksort  Average Memory: 26kB  Peak Memory: 26kB
	              Buffers: shared hit=31
	              ->  Index Scan using "Job_claim_idx" on "Job"  (cost=0.41..108.75 rows=59 width=37) (actual time=0.036..0.083 rows=33 loops=1)
	                    Index Cond: (("workspaceId" = 'default'::text) AND (queue = 'database'::text) AND (status = 'queued'::text) AND ("apiKeyId" = 'key_15'::text) AND (priority = 0))
	                    Filter: (type = ANY ('{render,preview}'::text[]))
	                    Buffers: shared hit=31

```

## PostgreSQL, main, 200 keys, 20,000 queued

```
duration: 0.019 ms  plan:
	GroupAggregate  (cost=7.76..7.78 rows=1 width=14) (actual time=0.018..0.018 rows=0 loops=1)
	  Group Key: "apiKeyId"
	  Buffers: shared hit=4
	  ->  Sort  (cost=7.76..7.77 rows=1 width=6) (actual time=0.017..0.018 rows=0 loops=1)
	        Sort Key: "apiKeyId"
	        Sort Method: quicksort  Memory: 25kB
	        Buffers: shared hit=4
	        ->  Index Scan using "Job_status_leaseExpiresAt_idx" on "Job"  (cost=0.29..7.75 rows=1 width=6) (actual time=0.014..0.014 rows=0 loops=1)
	              Index Cond: ((status = 'running'::text) AND ("leaseExpiresAt" IS NOT NULL))
	              Filter: (("apiKeyId" IS NOT NULL) AND ("workspaceId" = 'default'::text) AND (queue = 'database'::text))
	              Buffers: shared hit=4

duration: 13.701 ms  plan:
	HashAggregate  (cost=1602.83..1608.83 rows=600 width=18) (actual time=13.444..13.511 rows=601 loops=1)
	  Group Key: "apiKeyId", priority
	  Batches: 1  Memory Usage: 105kB
	  Buffers: shared hit=403
	  ->  Bitmap Heap Scan on "Job"  (cost=223.19..1452.93 rows=19987 width=18) (actual time=0.374..5.784 rows=19998 loops=1)
	        Recheck Cond: (status = 'queued'::text)
	        Filter: ((type = ANY ('{render,preview}'::text[])) AND ("workspaceId" = 'default'::text) AND (queue = 'database'::text))
	        Heap Blocks: exact=386
	        Buffers: shared hit=403
	        ->  Bitmap Index Scan on "Job_status_leaseExpiresAt_idx"  (cost=0.00..218.19 rows=19987 width=0) (actual time=0.330..0.330 rows=20000 loops=1)
	              Index Cond: (status = 'queued'::text)
	              Buffers: shared hit=17

duration: 0.371 ms  plan:
	Limit  (cost=34.32..62.62 rows=1 width=37) (actual time=0.369..0.370 rows=1 loops=1)
	  Buffers: shared hit=122
	  ->  LockRows  (cost=34.32..204.13 rows=6 width=37) (actual time=0.368..0.369 rows=1 loops=1)
	        Buffers: shared hit=122
	        ->  Incremental Sort  (cost=34.32..204.07 rows=6 width=37) (actual time=0.362..0.362 rows=1 loops=1)
	              Sort Key: "createdAt", id
	              Presorted Key: "createdAt"
	              Full-sort Groups: 1  Sort Method: quicksort  Average Memory: 25kB  Peak Memory: 25kB
	              Buffers: shared hit=121
	              ->  Index Scan using "Job_workspaceId_apiKeyId_createdAt_idx" on "Job"  (cost=0.41..203.80 rows=6 width=37) (actual time=0.286..0.354 rows=7 loops=1)
	                    Index Cond: (("workspaceId" = 'default'::text) AND ("apiKeyId" = 'key_15'::text))
	                    Filter: ((type = ANY ('{render,preview}'::text[])) AND (queue = 'database'::text) AND (status = 'queued'::text) AND (priority = 0))
	                    Rows Removed by Filter: 111
	                    Buffers: shared hit=121

```

## PostgreSQL, this change (first claim: the counting GROUP BY decides; then the skip scan), 200 keys, 20,000 queued

```
duration: 11.603 ms  plan:
	Hash Left Join  (cost=303.93..309.52 rows=202 width=52) (actual time=0.063..11.230 rows=601 loops=1)
	  Hash Cond: (g.k = r.k)
	  Buffers: shared hit=2481
	  CTE g
	    ->  Recursive Union  (cost=0.41..76.81 rows=101 width=18) (actual time=0.042..10.711 rows=600 loops=1)
	          Buffers: shared hit=2469
	          ->  Limit  (cost=0.41..0.58 rows=1 width=18) (actual time=0.039..0.040 rows=1 loops=1)
	                Buffers: shared hit=5
	                ->  Index Scan using "Job_claim_idx" on "Job" j  (cost=0.41..3176.52 rows=19547 width=18) (actual time=0.038..0.038 rows=1 loops=1)
	                      Index Cond: (("workspaceId" = 'default'::text) AND (queue = 'database'::text) AND (status = 'queued'::text) AND ("apiKeyId" IS NOT NULL))
	                      Filter: (type = ANY ('{render,preview}'::text[]))
	                      Buffers: shared hit=5
	          ->  Nested Loop  (cost=0.41..7.52 rows=10 width=18) (actual time=0.017..0.017 rows=1 loops=600)
	                Buffers: shared hit=2464
	                ->  WorkTable Scan on g g_1  (cost=0.00..0.20 rows=10 width=36) (actual time=0.000..0.000 rows=1 loops=600)
	                ->  Limit  (cost=0.41..0.72 rows=1 width=18) (actual time=0.016..0.017 rows=1 loops=600)
	                      Buffers: shared hit=2464
	                      ->  Index Scan using "Job_claim_idx" on "Job" j_1  (cost=0.41..2043.69 rows=6651 width=18) (actual time=0.016..0.016 rows=1 loops=600)
	                            Index Cond: (("workspaceId" = 'default'::text) AND (queue = 'database'::text) AND (status = 'queued'::text) AND (ROW("apiKeyId", priority) > ROW(g_1.k, g_1.p)))
	                            Filter: (type = ANY ('{render,preview}'::text[]))
	                            Buffers: shared hit=2464
	  CTE h
	    ->  Recursive Union  (cost=0.41..220.89 rows=101 width=18) (actual time=0.012..0.025 rows=1 loops=1)
	          Buffers: shared hit=7
	          ->  Limit  (cost=0.41..1.92 rows=1 width=18) (actual time=0.010..0.011 rows=1 loops=1)
	                Buffers: shared hit=4
	                ->  Index Scan using "Job_claim_idx" on "Job" j_2  (cost=0.41..608.80 rows=405 width=18) (actual time=0.010..0.010 rows=1 loops=1)
	                      Index Cond: (("workspaceId" = 'default'::text) AND (queue = 'database'::text) AND (status = 'queued'::text) AND ("apiKeyId" IS NULL))
	                      Filter: (type = ANY ('{render,preview}'::text[]))
	                      Buffers: shared hit=4
	          ->  Nested Loop  (cost=0.41..21.80 rows=10 width=18) (actual time=0.012..0.012 rows=0 loops=1)
	                Buffers: shared hit=3
	                ->  WorkTable Scan on h h_1  (cost=0.00..0.20 rows=10 width=4) (actual time=0.001..0.001 rows=1 loops=1)
	                ->  Limit  (cost=0.41..2.15 rows=1 width=18) (actual time=0.009..0.009 rows=0 loops=1)
	                      Buffers: shared hit=3
	                      ->  Index Scan using "Job_claim_idx" on "Job" j_3  (cost=0.41..234.59 rows=135 width=18) (actual time=0.008..0.008 rows=0 loops=1)
	                            Index Cond: (("workspaceId" = 'default'::text) AND (queue = 'database'::text) AND (status = 'queued'::text) AND ("apiKeyId" IS NULL) AND (priority > h_1.p))
	                            Filter: (type = ANY ('{render,preview}'::text[]))
	                            Buffers: shared hit=3
	  ->  Append  (cost=0.00..5.05 rows=202 width=44) (actual time=0.044..11.024 rows=601 loops=1)
	        Buffers: shared hit=2476
	        ->  CTE Scan on g  (cost=0.00..2.02 rows=101 width=44) (actual time=0.043..10.922 rows=600 loops=1)
	              Buffers: shared hit=2469
	        ->  CTE Scan on h  (cost=0.00..2.02 rows=101 width=44) (actual time=0.013..0.025 rows=1 loops=1)
	              Buffers: shared hit=7
	  ->  Hash  (cost=6.21..6.21 rows=1 width=14) (actual time=0.014..0.016 rows=0 loops=1)
	        Buckets: 1024  Batches: 1  Memory Usage: 8kB
	        Buffers: shared hit=5
	        ->  Subquery Scan on r  (cost=0.41..6.21 rows=1 width=14) (actual time=0.014..0.015 rows=0 loops=1)
	              Buffers: shared hit=5
	              ->  GroupAggregate  (cost=0.41..6.21 rows=1 width=14) (actual time=0.013..0.014 rows=0 loops=1)
	                    Group Key: r_1."apiKeyId"
	                    Buffers: shared hit=5
	                    ->  Index Scan using "Job_claim_idx" on "Job" r_1  (cost=0.41..6.19 rows=1 width=6) (actual time=0.013..0.013 rows=0 loops=1)
	                          Index Cond: (("workspaceId" = 'default'::text) AND (queue = 'database'::text) AND (status = 'running'::text) AND ("apiKeyId" IS NOT NULL))
	                          Filter: ("leaseExpiresAt" IS NOT NULL)
	                          Buffers: shared hit=5

duration: 0.047 ms  plan:
	Limit  (cost=3.25..5.65 rows=1 width=37) (actual time=0.045..0.046 rows=1 loops=1)
	  Buffers: shared hit=11
	  ->  LockRows  (cost=3.25..17.68 rows=6 width=37) (actual time=0.044..0.045 rows=1 loops=1)
	        Buffers: shared hit=11
	        ->  Incremental Sort  (cost=3.25..17.62 rows=6 width=37) (actual time=0.039..0.039 rows=1 loops=1)
	              Sort Key: "createdAt", id
	              Presorted Key: "createdAt"
	              Full-sort Groups: 1  Sort Method: quicksort  Average Memory: 25kB  Peak Memory: 25kB
	              Buffers: shared hit=10
	              ->  Index Scan using "Job_claim_idx" on "Job"  (cost=0.41..17.34 rows=6 width=37) (actual time=0.020..0.030 rows=7 loops=1)
	                    Index Cond: (("workspaceId" = 'default'::text) AND (queue = 'database'::text) AND (status = 'queued'::text) AND ("apiKeyId" = 'key_15'::text) AND (priority = 0))
	                    Filter: (type = ANY ('{render,preview}'::text[]))
	                    Buffers: shared hit=10

```

## MySQL 8.4, 20,000 queued, 200 keys

main: the type-filtered GROUP BY reads every queued row from the table (index lookup, then a filter on `type`):

```
-> Group aggregate: min(J.c)  (cost=1042 rows=1606) (actual time=0.724..52.5 rows=603 loops=1)
    -> Filter: (J.ty in ('render','preview'))  (cost=677 rows=3646) (actual time=0.126..49.7 rows=20000 loops=1)
        -> Index lookup on J using ix (ws='default', q='database', st='queued')  (cost=677 rows=18230) (actual time=0.124..46.2 rows=20000 loops=1)
```

This change: the GROUP BY of the claim index without `type` is covered by the index (no table reads):

```
-> Group aggregate: min(J.c)  (cost=5165 rows=6444) (actual time=0.117..11.3 rows=603 loops=1)
    -> Covering index lookup on J using ix (ws='default', q='database', st='queued')  (cost=3342 rows=18230) (actual time=0.0284..8.54 rows=20000 loops=1)
```

Rejected: a recursive skip scan with a LATERAL step re-reads the whole (workspace, queue, status) range on every step, because MySQL cannot range-seek on an outer reference (6.1 ms a step, 600 steps, 4 s in all):

```
-> Index lookup on j using ix (ws='default', q='database', st='queued'), with index condition: ((j.k > g.k) or ((j.k = g.k) and (j.p > g.p)))  (cost=442 rows=18230) (actual time=6.13..6.13 rows=0.998 loops=600)
```

A loose index scan for the GROUP BY (`GROUP_INDEX` hint) is not used for this index: MySQL falls back to a full index scan with a temporary table (43 ms).
