fpath = r'c:\Users\USER\Desktop\SWINBURNE LEARNING MATERIAL\sport_app\frontend\app\event\eventPanel.tsx'
with open(fpath, 'r', encoding='utf-8') as f:
    content = f.read()

T = '\t'

# 1. Remove flexDirection:row + alignItems:center from applicants outer card style only
# Target context: after applicants.map and key={a.booking.eventbookingid}
old1 = (T*9 + 'key={a.booking.eventbookingid}\n' +
        T*9 + 'style={{\n' +
        T*10 + 'backgroundColor: "#fff",\n' +
        T*10 + 'borderRadius: 12,\n' +
        T*10 + 'padding: 12,\n' +
        T*10 + 'flexDirection: "row",\n' +
        T*10 + 'alignItems: "center",\n' +
        T*10 + 'marginBottom: 10,\n' +
        T*9 + '}}')
new1 = (T*9 + 'key={a.booking.eventbookingid}\n' +
        T*9 + 'style={{\n' +
        T*10 + 'backgroundColor: "#fff",\n' +
        T*10 + 'borderRadius: 12,\n' +
        T*10 + 'padding: 12,\n' +
        T*10 + 'marginBottom: 10,\n' +
        T*9 + '}}')
c1 = content.count(old1)
print('Step 1 matches:', c1)
assert c1 == 1, f'Expected 1 for step 1, got {c1}'
content = content.replace(old1, new1)

# 2. After card opening > at 8T, add wrapping row View before the 10T profile TouchableOpacity
# Use full applicants card context to ensure uniqueness
old2 = (T*9 + 'key={a.booking.eventbookingid}\n' +
        T*9 + 'style={{\n' +
        T*10 + 'backgroundColor: "#fff",\n' +
        T*10 + 'borderRadius: 12,\n' +
        T*10 + 'padding: 12,\n' +
        T*10 + 'marginBottom: 10,\n' +
        T*9 + '}}\n' +
        T*8 + '>\n' +
        T*10 + '<TouchableOpacity\n' +
        T*11 + 'activeOpacity={0.75}')
new2 = (T*9 + 'key={a.booking.eventbookingid}\n' +
        T*9 + 'style={{\n' +
        T*10 + 'backgroundColor: "#fff",\n' +
        T*10 + 'borderRadius: 12,\n' +
        T*10 + 'padding: 12,\n' +
        T*10 + 'marginBottom: 10,\n' +
        T*9 + '}}\n' +
        T*8 + '>\n' +
        T*9 + '<View style={{ flexDirection: "row", alignItems: "center" }}>\n' +
        T*10 + '<TouchableOpacity\n' +
        T*11 + 'activeOpacity={0.75}')
c2 = content.count(old2)
print('Step 2 matches:', c2)
assert c2 == 1, f'Expected 1 for step 2, got {c2}'
content = content.replace(old2, new2)

# 3. Add pen icon between reject </TouchableOpacity> and dotdotdot TouchableOpacity
old3 = (T*10 + '</TouchableOpacity>\n' +
        T*10 + '<TouchableOpacity\n' +
        T*11 + 'activeOpacity={0.7}\n' +
        T*11 + 'onPress={(e) => {\n' +
        T*12 + 'openActionMenuForUser')
new3 = (T*10 + '</TouchableOpacity>\n' +
        T*10 + '<TouchableOpacity\n' +
        T*11 + 'activeOpacity={0.75}\n' +
        T*11 + 'onPress={() => setExpandedNoteEventIds(prev => {\n' +
        T*12 + 'const n = new Set(prev);\n' +
        T*12 + 'if (n.has(a.booking.eventbookingid)) n.delete(a.booking.eventbookingid);\n' +
        T*12 + 'else n.add(a.booking.eventbookingid);\n' +
        T*12 + 'return n;\n' +
        T*11 + '})}\n' +
        T*11 + 'style={{ padding: 6, alignItems: "center", justifyContent: "center", marginLeft: 2 }}\n' +
        T*10 + '>\n' +
        T*11 + '<Text style={{ fontSize: 16 }}>\u270f\ufe0f</Text>\n' +
        T*10 + '</TouchableOpacity>\n' +
        T*10 + '<TouchableOpacity\n' +
        T*11 + 'activeOpacity={0.7}\n' +
        T*11 + 'onPress={(e) => {\n' +
        T*12 + 'openActionMenuForUser')
c3 = content.count(old3)
print('Step 3 matches:', c3)
assert c3 == 1, f'Expected 1 for step 3, got {c3}'
content = content.replace(old3, new3)

# 4. Close wrapping row View, add note section, before outer card close
old4 = (T*9 + '</View>\n' +    # close buttons row View
        T*8 + '</View>\n' +    # close outer card
        T*7 + '))}')
new4 = (T*9 + '</View>\n' +    # close buttons row View
        T*9 + '</View>\n' +    # close wrapping row View (NEW)
        T*9 + '{expandedNoteEventIds.has(a.booking.eventbookingid) && (\n' +
        T*10 + '<View style={{ marginTop: 8, backgroundColor: "#f9fafb", borderRadius: 8, padding: 10, borderLeftWidth: 3, borderLeftColor: "#d1d5db" }}>\n' +
        T*11 + '<Text style={{ fontSize: 12, fontWeight: "700", color: "#374151", marginBottom: 4 }}>Note</Text>\n' +
        T*11 + '<Text style={{ fontSize: 13, color: "#555" }}>{(a.booking as any).note?.trim() ? (a.booking as any).note : "No note provided."}</Text>\n' +
        T*10 + '</View>\n' +
        T*9 + ')}\n' +
        T*8 + '</View>\n' +    # close outer card
        T*7 + '))}')
c4 = content.count(old4)
print('Step 4 matches:', c4)
assert c4 == 1, f'Expected 1 for step 4, got {c4}'
content = content.replace(old4, new4)

with open(fpath, 'w', encoding='utf-8') as f:
    f.write(content)
print('All done! File written successfully.')
