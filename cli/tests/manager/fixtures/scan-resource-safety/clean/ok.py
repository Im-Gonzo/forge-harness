# ok.py — a benign NO-SHEBANG python interpreter source. No network egress, no shell
# execution, no secret access. Pure computation + stdout. Must scan CLEAN.
def add(a, b):
    return a + b


def greet(name):
    return "hello, " + name


if __name__ == "__main__":
    total = add(2, 3)
    print(greet("forge"))
    print(total)
