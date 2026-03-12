fpath = r'c:\Users\USER\Desktop\SWINBURNE LEARNING MATERIAL\sport_app\frontend\app\event\trainingSessionPanel.tsx'
with open(fpath, 'r', encoding='utf-8') as f:
    content = f.read()

S = ' '

# ========== APPLICANTS SECTION ==========
# Step A1: Remove flexDirection + alignItems from applicants card style
old_a1 = (S*18 + "key={a.booking.tsbookingid}\n" +
          S*18 + "style={{\n" +
          S*20 + "backgroundColor: '#fff',\n" +
          S*20 + "borderRadius: 12,\n" +
          S*20 + "padding: 12,\n" +
          S*20 + "flexDirection: 'row',\n" +
          S*20 + "alignItems: 'center',\n" +
          S*20 + "marginBottom: 10,\n" +
          S*18 + "}}")
new_a1 = (S*18 + "key={a.booking.tsbookingid}\n" +
          S*18 + "style={{\n" +
          S*20 + "backgroundColor: '#fff',\n" +
          S*20 + "borderRadius: 12,\n" +
          S*20 + "padding: 12,\n" +
          S*20 + "marginBottom: 10,\n" +
          S*18 + "}}")
c_a1 = content.count(old_a1)
print('Applicants step 1 matches:', c_a1)
assert c_a1 == 1, f'Expected 1, got {c_a1}'
content = content.replace(old_a1, new_a1)

# Step A2: After card > at S16, add row wrapper View before profile TouchableOpacity
old_a2 = (S*18 + "}}\n" +
          S*16 + ">\n" +
          S*18 + "<TouchableOpacity\n" +
          S*20 + "activeOpacity={0.75}\n" +
          S*20 + "onPress={() =>\n" +
          S*22 + "router.push")
new_a2 = (S*18 + "}}\n" +
          S*16 + ">\n" +
          S*18 + "<View style={{ flexDirection: 'row', alignItems: 'center' }}>\n" +
          S*18 + "<TouchableOpacity\n" +
          S*20 + "activeOpacity={0.75}\n" +
          S*20 + "onPress={() =>\n" +
          S*22 + "router.push")
c_a2 = content.count(old_a2)
print('Applicants step 2 matches:', c_a2)
assert c_a2 == 1, f'Expected 1, got {c_a2}'
content = content.replace(old_a2, new_a2)

# Step A3: Add pen icon between reject </TouchableOpacity> and dotdotdot TouchableOpacity
old_a3 = (S*20 + "</TouchableOpacity>\n\n" +
          S*20 + "<TouchableOpacity\n" +
          S*22 + "activeOpacity={0.7}\n" +
          S*22 + "onPress={(e) => {\n" +
          S*24 + "openActionMenuForUser(a.booking.userid")
new_a3 = (S*20 + "</TouchableOpacity>\n\n" +
          S*20 + "<TouchableOpacity\n" +
          S*22 + "activeOpacity={0.75}\n" +
          S*22 + "onPress={() => setExpandedNoteIds(prev => {\n" +
          S*24 + "const n = new Set(prev);\n" +
          S*24 + "if (n.has(a.booking.tsbookingid)) n.delete(a.booking.tsbookingid);\n" +
          S*24 + "else n.add(a.booking.tsbookingid);\n" +
          S*24 + "return n;\n" +
          S*22 + "})}\n" +
          S*22 + "style={{ padding: 6, alignItems: 'center', justifyContent: 'center', marginLeft: 2 }}\n" +
          S*20 + ">\n" +
          S*22 + "<Text style={{ fontSize: 16 }}>\u270f\ufe0f</Text>\n" +
          S*20 + "</TouchableOpacity>\n\n" +
          S*20 + "<TouchableOpacity\n" +
          S*22 + "activeOpacity={0.7}\n" +
          S*22 + "onPress={(e) => {\n" +
          S*24 + "openActionMenuForUser(a.booking.userid")
c_a3 = content.count(old_a3)
print('Applicants step 3 matches:', c_a3)
assert c_a3 == 1, f'Expected 1, got {c_a3}'
content = content.replace(old_a3, new_a3)

# Step A4: Close row wrapper View, add note expand, before card close
old_a4 = (S*18 + "</View>\n" +    # buttons row close
          S*16 + "</View>\n" +    # card close
          S*14 + "))}\n")         # map close - first occurrence is applicants
# Check that the first one in context is from applicants
# Find the applicants context by looking for applicants
app_idx = content.find('{applicants.map((a) => (')
part_idx = content.find('{participants.map((p) => (')
# Find old_a4 only within applicants section
app_end_region = content.find(old_a4, app_idx)
print(f'Applicants A4 at index {app_end_region}; participants start at {part_idx}')
assert app_end_region < part_idx, 'Pattern found in wrong place'
assert app_end_region != -1, 'Pattern not found'

new_a4 = (S*18 + "</View>\n" +    # buttons row close
          S*18 + "</View>\n" +    # row wrapper close (NEW)
          S*18 + "{expandedNoteIds.has(a.booking.tsbookingid) && (\n" +
          S*20 + "<View style={{ marginTop: 8, backgroundColor: '#f9fafb', borderRadius: 8, padding: 10, borderLeftWidth: 3, borderLeftColor: '#d1d5db' }}>\n" +
          S*22 + "<Text style={{ fontSize: 12, fontWeight: '700', color: '#374151', marginBottom: 4 }}>Note</Text>\n" +
          S*22 + "<Text style={{ fontSize: 13, color: '#555' }}>{(a.booking as any).note?.trim() ? (a.booking as any).note : 'No note provided.'}</Text>\n" +
          S*20 + "</View>\n" +
          S*18 + ")}\n" +
          S*16 + "</View>\n" +    # card close
          S*14 + "))}\n")         # map close

# Only replace first occurrence (applicants)
before = content[:app_end_region]
after = content[app_end_region:]
after = after.replace(old_a4, new_a4, 1)
content = before + after
print('Applicants step 4 done')

# ========== PARTICIPANTS SECTION ==========
# Step P1: Remove flexDirection + alignItems from participants card style
old_p1 = (S*18 + "key={p.booking.tsbookingid}\n" +
          S*18 + "style={{\n" +
          S*20 + "backgroundColor: '#fff',\n" +
          S*20 + "borderRadius: 12,\n" +
          S*20 + "padding: 12,\n" +
          S*20 + "flexDirection: 'row',\n" +
          S*20 + "alignItems: 'center',\n" +
          S*20 + "marginBottom: 10,\n" +
          S*18 + "}}")
new_p1 = (S*18 + "key={p.booking.tsbookingid}\n" +
          S*18 + "style={{\n" +
          S*20 + "backgroundColor: '#fff',\n" +
          S*20 + "borderRadius: 12,\n" +
          S*20 + "padding: 12,\n" +
          S*20 + "marginBottom: 10,\n" +
          S*18 + "}}")
c_p1 = content.count(old_p1)
print('Participants step 1 matches:', c_p1)
assert c_p1 == 1, f'Expected 1, got {c_p1}'
content = content.replace(old_p1, new_p1)

# Step P2: After card > at S16, add row wrapper View before profile TouchableOpacity
old_p2 = (S*18 + "}}\n" +
          S*16 + ">\n" +
          S*18 + "<TouchableOpacity\n" +
          S*20 + "activeOpacity={0.7}\n" +
          S*20 + "onPress={(e) => {\n" +
          S*22 + "openActionMenuForUser(p.booking.userid, p.name")
new_p2 = (S*18 + "}}\n" +
          S*16 + ">\n" +
          S*18 + "<View style={{ flexDirection: 'row', alignItems: 'center' }}>\n" +
          S*18 + "<TouchableOpacity\n" +
          S*20 + "activeOpacity={0.7}\n" +
          S*20 + "onPress={(e) => {\n" +
          S*22 + "openActionMenuForUser(p.booking.userid, p.name")
c_p2 = content.count(old_p2)
print('Participants step 2 matches:', c_p2)
assert c_p2 == 1, f'Expected 1, got {c_p2}'
content = content.replace(old_p2, new_p2)

# Step P3: Add pen icon between profile </TouchableOpacity> and dotdotdot TouchableOpacity
old_p3 = (S*18 + "</TouchableOpacity>\n" +
          S*18 + "<TouchableOpacity\n" +
          S*20 + "activeOpacity={0.7}\n" +
          S*20 + "onPress={(e) => {\n" +
          S*22 + "openActionMenuForUser(p.booking.userid, p.name")
new_p3 = (S*18 + "</TouchableOpacity>\n" +
          S*18 + "<TouchableOpacity\n" +
          S*20 + "activeOpacity={0.75}\n" +
          S*20 + "onPress={() => setExpandedNoteIds(prev => {\n" +
          S*22 + "const n = new Set(prev);\n" +
          S*22 + "if (n.has(p.booking.tsbookingid)) n.delete(p.booking.tsbookingid);\n" +
          S*22 + "else n.add(p.booking.tsbookingid);\n" +
          S*22 + "return n;\n" +
          S*20 + "})}\n" +
          S*20 + "style={{ padding: 6, alignItems: 'center', justifyContent: 'center', marginLeft: 2 }}\n" +
          S*18 + ">\n" +
          S*20 + "<Text style={{ fontSize: 16 }}>\u270f\ufe0f</Text>\n" +
          S*18 + "</TouchableOpacity>\n" +
          S*18 + "<TouchableOpacity\n" +
          S*20 + "activeOpacity={0.7}\n" +
          S*20 + "onPress={(e) => {\n" +
          S*22 + "openActionMenuForUser(p.booking.userid, p.name")
c_p3 = content.count(old_p3)
print('Participants step 3 matches:', c_p3)
assert c_p3 == 1, f'Expected 1, got {c_p3}'
content = content.replace(old_p3, new_p3)

# Step P4: Close row wrapper, add note expand, card close
old_p4 = (S*18 + "</TouchableOpacity>\n" +
          S*16 + "</View>\n" +
          S*14 + "))}\n")         # participants map close
new_p4 = (S*18 + "</TouchableOpacity>\n" +
          S*18 + "</View>\n" +    # row wrapper close (NEW)
          S*18 + "{expandedNoteIds.has(p.booking.tsbookingid) && (\n" +
          S*20 + "<View style={{ marginTop: 8, backgroundColor: '#f9fafb', borderRadius: 8, padding: 10, borderLeftWidth: 3, borderLeftColor: '#d1d5db' }}>\n" +
          S*22 + "<Text style={{ fontSize: 12, fontWeight: '700', color: '#374151', marginBottom: 4 }}>Note</Text>\n" +
          S*22 + "<Text style={{ fontSize: 13, color: '#555' }}>{(p.booking as any).note?.trim() ? (p.booking as any).note : 'No note provided.'}</Text>\n" +
          S*20 + "</View>\n" +
          S*18 + ")}\n" +
          S*16 + "</View>\n" +    # card close
          S*14 + "))}\n")         # map close
c_p4 = content.count(old_p4)
print('Participants step 4 matches:', c_p4)
assert c_p4 == 1, f'Expected 1, got {c_p4}'
content = content.replace(old_p4, new_p4)

with open(fpath, 'w', encoding='utf-8') as f:
    f.write(content)
print('All done! trainingSessionPanel.tsx written successfully.')
