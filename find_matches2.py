fpath = r'c:\Users\USER\Desktop\SWINBURNE LEARNING MATERIAL\sport_app\frontend\app\event\eventPanel.tsx'
with open(fpath, 'r', encoding='utf-8') as f:
    content = f.read()
T = '\t'

# After step 1 has been applied, check step 2 pattern
# First simulate step 1
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
content = content.replace(old1, new1)

# Now test step 2 - use the key to uniquely identify applicants list
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
c2 = content.count(old2)
print('Step 2 matches:', c2)
