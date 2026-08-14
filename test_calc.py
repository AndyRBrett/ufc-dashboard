from calc import add


def test_add():
    assert add(2, 3) == 5, f'add(2,3) returned {add(2, 3)}'


if __name__ == "__main__":
    test_add()
    print("ok")
