# @ton/watch

This project is only intended for indexing small amount of addresses, if you want to index a large amount of addresses or the whole blockchain,
take a look at [ton-indexer](https://github.com/toncenter/ton-indexer) or [ton-index-wokrer](https://github.com/toncenter/ton-index-worker).


Currently this writes about 1000 transactions per minute.

NOTE: avoid errors on same transaction writing from multiple wallets, there can be duplicate transactions
if we have both addresses in parsers source and the target, for one it will be incoming for the other outgoing.

This project was created using `bun init` in bun v1.1.0. [Bun](https://bun.sh) is a fast all-in-one JavaScript runtime.

Pagination based parser for ton blockchain

### Store
 
Represents a data storage for off-chain database. This must have 2 cursors, `first` and `last`.
first - must represent the latest transaction in the database.
last - must represent the oldest transaction in the database.
It must be guaranteed that the database has all the transactions between the `first` and `last` cursors.


### Chain

Represents a blockchain. Must have 2 cursors, `first` and `last`.
`latest` - must represent the latest block in the blockchain.
`hasNext` - must return true if there is a next block in the blockchain, newer than the `first`.
`oldest` - must represent the oldest block in the Store.
`hasPrevious` - must return true if there is a previous block in the blockchain, older than the `last`.


### Parser

When the parser starts it must first initialize the Store to know the state of the database.
The `latest` cursor must be set to the latest transaction in the database.
The `oldest` cursor must be set to the oldest transaction in the database.

Then it must initialize the Chain to know the state of the blockchain.
The `latest` cursor must be set to the latest block in the blockchain.
The `oldest` cursor must be set to the oldest block in the DATABASE, as there is no way to know the oldest block in the blockchain,
unless you go back with previous blocks until the first transaction of the address.

Then the parser must start parsing the blockchain using strategy. (forward, backward, bidirectional)
It must have 2 directions forward and backward.

Forward - must compare `latest` cursor of the Store with the `latest` cursor of the Chain,
if they don't match, it must get N more before 

There must be 3 strategies forward, backward, and bidirectional.

