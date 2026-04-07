with open(r'c:\Users\USER\Desktop\SWINBURNE LEARNING MATERIAL\sport_app\frontend\app\event\eventPanel.tsx', 'r', encoding='utf-8') as f:
    content = f.read()

# Step 1: Remove medal from inside TouchableOpacity
medal_inside_start = content.find('\t\t\t\t\t\t\t\t\t<View\n\t\t\t\t\t\t\t\t\t\tpointerEvents="none"\n\t\t\t\t\t\t\t\t\t\tstyle={{\n\t\t\t\t\t\t\t\t\t\t\tposition: "absolute",\n\t\t\t\t\t\t\t\t\t\t\ttop: 6,')
print('Medal inside start:', medal_inside_start)
if medal_inside_start >= 0:
    end_marker = '</View>\n\t\t\t\t\t\t\t\t\t<View style={{ flex: 1, minWidth: 0, paddingRight: 62 }}>'
    medal_inside_end = content.find(end_marker, medal_inside_start)
    print('Medal inside end:', medal_inside_end)
    if medal_inside_end >= 0:
        end_pos = medal_inside_end + len('</View>\n')
        content = content[:medal_inside_start] + content[end_pos:]
        print('Medal removed from inside TouchableOpacity')
    else:
        print('Cannot find end of medal View')
else:
    print('Cannot find medal View inside - checking current state')
    idx = content.find('ICONS.eventDeco')
    print(repr(content[idx-300:idx+100]))

# Step 2: Add medal after </TouchableOpacity>
close_to = '</TouchableOpacity>\n\t\t\t\t\t\t\t</View>'
count2 = content.count(close_to)
print(f'Closing pattern count: {count2}')
if count2 == 1:
    medal_outside = (
        '</TouchableOpacity>\n'
        '\t\t\t\t\t\t\t<View\n'
        '\t\t\t\t\t\t\t\tpointerEvents="none"\n'
        '\t\t\t\t\t\t\t\tstyle={{\n'
        '\t\t\t\t\t\t\t\t\tposition: "absolute",\n'
        '\t\t\t\t\t\t\t\t\ttop: 6,\n'
        '\t\t\t\t\t\t\t\t\tright: 6,\n'
        '\t\t\t\t\t\t\t\t\twidth: 46,\n'
        '\t\t\t\t\t\t\t\t\theight: 46,\n'
        '\t\t\t\t\t\t\t\t\topacity: selected ? 0.95 : 0.9,\n'
        '\t\t\t\t\t\t\t\t\tzIndex: 2,\n'
        '\t\t\t\t\t\t\t\t}}\n'
        '\t\t\t\t\t\t\t>\n'
        '\t\t\t\t\t\t\t\t<Image source={ICONS.eventDeco} resizeMode="contain" style={{ width: "100%", height: "100%" }} />\n'
        '\t\t\t\t\t\t\t</View>\n'
        '\t\t\t\t\t\t\t</View>'
    )
    content = content.replace(close_to, medal_outside, 1)
    print('Medal added outside TouchableOpacity')
elif count2 > 1:
    print(f'Multiple ({count2}) occurrences of closing pattern - need more context')

with open(r'c:\Users\USER\Desktop\SWINBURNE LEARNING MATERIAL\sport_app\frontend\app\event\eventPanel.tsx', 'w', encoding='utf-8') as f:
    f.write(content)
print('File saved successfully')
