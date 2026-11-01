.PHONY: test lint build dev start serve all

all: lint test build

test:
	npm test

lint:
	npm run lint

build:
	npm run build

dev:
	npm run dev

start:
	node src/server.js

serve:
	node src/server.js


