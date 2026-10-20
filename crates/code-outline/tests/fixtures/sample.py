"""Module docstring."""

from dataclasses import dataclass


@dataclass
class Point:
    x: int

    def norm(self):
        return self.x


class Box:
    @property
    def x(self):
        return 1

    @x.setter
    def x(self, v):
        pass


async def fetch():
    return 1


def outer():
    def inner():
        return 1
    return inner


@app.route(
    "/x")
def route():
    return 1
