import os

path = 'assets/css/main.scss'
with open(path, 'r') as f:
    content = f.read()

# Check if it starts with the bad pattern
if content.startswith('--- --- // Modern Typography'):
    new_content = '---\n---\n\n// Modern Typography' + content[len('--- --- // Modern Typography'):]
    with open(path, 'w') as f:
        f.write(new_content)
    print("Fixed front matter.")
else:
    print("Front matter pattern not found, printing start:")
    print(content[:50])
