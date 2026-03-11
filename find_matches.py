fpath = r'c:\Users\USER\Desktop\SWINBURNE LEARNING MATERIAL\sport_app\frontend\app\event\eventPanel.tsx'
with open(fpath, 'r', encoding='utf-8') as f:
    content = f.read()
T = '\t'
old1 = T*10 + 'padding: 12,\n' + T*10 + 'flexDirection: "row",\n' + T*10 + 'alignItems: "center",\n' + T*10 + 'marginBottom: 10,'
start = 0
count = 0
while True:
    idx = content.find(old1, start)
    if idx == -1: break
    count += 1
    print(f'Match {count} at index {idx}')
    print('Context before:', repr(content[idx-200:idx]))
    start = idx + 1
print('Total:', count)
