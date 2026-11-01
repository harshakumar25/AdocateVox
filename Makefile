.PHONY: test lint build dev start all

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
	npm start

