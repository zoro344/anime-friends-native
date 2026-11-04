package com.animefriends.app

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

private val Bg = Color(0xFF101018)
private val Surface = Color(0xFF1B1B28)
private val Accent = Color(0xFF9B72F2)
private val Muted = Color(0xFFAAA8B8)

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { AnimeFriendsApp() }
    }
}

private object Api {
    private val client = OkHttpClient.Builder().callTimeout(25, TimeUnit.SECONDS).build()
    private val jsonType = "application/json; charset=utf-8".toMediaType()
    suspend fun call(base: String, path: String, method: String = "GET", body: JSONObject? = null, token: String? = null): JSONObject = withContext(Dispatchers.IO) {
        val url = base.trimEnd('/') + path
        val builder = Request.Builder().url(url).header("Accept", "application/json")
        if (!token.isNullOrBlank()) builder.header("Authorization", "Bearer $token")
        when (method) {
            "POST" -> builder.post((body ?: JSONObject()).toString().toRequestBody(jsonType))
            "PUT" -> builder.put((body ?: JSONObject()).toString().toRequestBody(jsonType))
            "DELETE" -> builder.delete()
            else -> builder.get()
        }
        client.newCall(builder.build()).execute().use { response ->
            val raw = response.body?.string().orEmpty()
            val result = try { JSONObject(raw) } catch (_: Exception) { JSONObject().put("message", raw) }
            if (!response.isSuccessful || result.optBoolean("error")) throw IOException(result.optString("message", "Request failed (${response.code})"))
            result
        }
    }
}

@Composable
private fun AnimeFriendsApp() {
    val context = LocalContext.current
    val prefs = remember { context.getSharedPreferences("anime_friends", 0) }
    var baseUrl by remember { mutableStateOf(prefs.getString("base_url", "http://10.0.2.2:3000") ?: "http://10.0.2.2:3000") }
    var token by remember { mutableStateOf(prefs.getString("token", null)) }
    var username by remember { mutableStateOf(prefs.getString("username", "") ?: "") }
    var tab by remember { mutableStateOf("Anime") }
    var message by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()

    MaterialTheme(colorScheme = darkColorScheme(primary = Accent, background = Bg, surface = Surface, onBackground = Color.White, onSurface = Color.White)) {
        Surface(Modifier.fillMaxSize(), color = Bg) {
            if (token.isNullOrBlank()) {
                AuthScreen(baseUrl, onBaseUrl = { baseUrl = it; prefs.edit().putString("base_url", it).apply() }, onMessage = { message = it }, onAuth = { user, authToken ->
                    username = user; token = authToken
                    prefs.edit().putString("token", authToken).putString("username", user).apply()
                })
            } else {
                Scaffold(containerColor = Bg, topBar = {
                    Column(Modifier.fillMaxWidth().background(Bg).padding(horizontal = 20.dp, vertical = 14.dp)) {
                        Text("ANIME FRIENDS", color = Accent, fontSize = 12.sp, fontWeight = FontWeight.Bold, letterSpacing = 2.sp)
                        Text("Hey, $username", fontSize = 24.sp, fontWeight = FontWeight.Bold)
                    }
                }, bottomBar = {
                    NavigationBar(containerColor = Surface) {
                        listOf("Anime", "News", "Feed", "Watch", "Profile").forEach { item ->
                            val icon = when (item) { "Anime" -> Icons.Default.Tv; "News" -> Icons.Default.Newspaper; "Feed" -> Icons.Default.Forum; "Watch" -> Icons.Default.Groups; else -> Icons.Default.Person }
                            NavigationBarItem(selected = tab == item, onClick = { tab = item }, icon = { Icon(icon, null) }, label = { Text(item) }, colors = NavigationBarItemDefaults.colors(selectedIconColor = Accent, indicatorColor = Accent.copy(alpha = .18f), selectedTextColor = Color.White, unselectedTextColor = Muted))
                        }
                    }
                }) { padding ->
                    Box(Modifier.padding(padding).fillMaxSize()) {
                        when (tab) {
                            "Anime" -> AnimeScreen(baseUrl, token!!, onMessage = { message = it })
                            "News" -> NewsScreen(baseUrl, token!!, onMessage = { message = it })
                            "Feed" -> FeedScreen(baseUrl, token!!, username, onMessage = { message = it })
                            "Watch" -> WatchScreen(baseUrl, token!!, username, onMessage = { message = it })
                            else -> ProfileScreen(username, baseUrl, onBaseUrl = { baseUrl = it; prefs.edit().putString("base_url", it).apply() }, onLogout = { prefs.edit().remove("token").apply(); token = null })
                        }
                    }
                }
                if (message.isNotBlank()) AlertDialog(onDismissRequest = { message = "" }, confirmButton = { TextButton2("OK") { message = "" } }, title = { Text("Anime Friends") }, text = { Text(message) })
            }
        }
    }
}

@Composable private fun TextButton2(label: String, onClick: () -> Unit) { TextButton(onClick = onClick) { Text(label) } }

@Composable
private fun AuthScreen(baseUrl: String, onBaseUrl: (String) -> Unit, onMessage: (String) -> Unit, onAuth: (String, String) -> Unit) {
    var user by remember { mutableStateOf("") }; var pass by remember { mutableStateOf("") }; var server by remember { mutableStateOf(baseUrl) }; var signup by remember { mutableStateOf(true) }; var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.Center) {
        Text("ANIME FRIENDS", color = Accent, fontSize = 13.sp, fontWeight = FontWeight.Bold, letterSpacing = 2.sp)
        Spacer(Modifier.height(12.dp)); Text(if (signup) "Join your anime community." else "Welcome back.", fontSize = 30.sp, fontWeight = FontWeight.Bold)
        Text("Discover anime. Share your thoughts. Watch together.", color = Muted)
        Spacer(Modifier.height(28.dp))
        OutlinedTextField(user, { user = it }, label = { Text("Username") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
        Spacer(Modifier.height(10.dp)); OutlinedTextField(pass, { pass = it }, label = { Text("Password") }, modifier = Modifier.fillMaxWidth(), visualTransformation = PasswordVisualTransformation(), singleLine = true)
        Spacer(Modifier.height(10.dp)); OutlinedTextField(server, { server = it; onBaseUrl(it) }, label = { Text("Backend URL") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
        Spacer(Modifier.height(18.dp)); Button(onClick = {
            if (user.isBlank() || pass.length < 8) { onMessage("Enter a username and a password with at least 8 characters."); return@Button }
            busy = true
            scope.launch { try { val r = Api.call(server, if (signup) "/api/auth/signup" else "/api/auth/login", "POST", JSONObject().put("username", user).put("password", pass)); onAuth(r.getJSONObject("user").optString("username", user), r.optString("token")) } catch (e: Exception) { onMessage(e.message ?: "Could not connect") } finally { busy = false } }
        }, modifier = Modifier.fillMaxWidth(), enabled = !busy) { Text(if (busy) "Please wait…" else if (signup) "Create account" else "Log in") }
        TextButton(onClick = { signup = !signup }, modifier = Modifier.align(Alignment.CenterHorizontally)) { Text(if (signup) "Already registered? Log in" else "New here? Create an account") }
        Text("Use your computer's LAN IP instead of 10.0.2.2 on a physical phone.", color = Muted, fontSize = 11.sp)
    }
}

@Composable
private fun AnimeScreen(base: String, token: String, onMessage: (String) -> Unit) {
    var query by remember { mutableStateOf("") }; var results by remember { mutableStateOf(listOf<JSONObject>()) }; var loading by remember { mutableStateOf(false) }; val scope = rememberCoroutineScope()
    Column(Modifier.fillMaxSize().padding(16.dp)) {
        Text("Find your next favourite", fontSize = 22.sp, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(12.dp)); OutlinedTextField(query, { query = it }, modifier = Modifier.fillMaxWidth(), label = { Text("Search anime") }, trailingIcon = { IconButton(onClick = { loading = true; scope.launch { try { val r = Api.call(base, "/api/anime/search?q=${Uri.encode(query)}", token = token); val arr = r.optJSONArray("results") ?: JSONArray(); results = (0 until arr.length()).map { arr.getJSONObject(it) } } catch (e: Exception) { onMessage(e.message ?: "Search failed") } finally { loading = false } } }) { Icon(Icons.Default.Search, null) } })
        Spacer(Modifier.height(12.dp)); if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())
        LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) { items(results) { anime -> Card(colors = CardDefaults.cardColors(containerColor = Surface), shape = RoundedCornerShape(16.dp), modifier = Modifier.fillMaxWidth()) { Column(Modifier.padding(14.dp)) { Text(anime.optString("title", "Untitled"), fontWeight = FontWeight.Bold, fontSize = 17.sp); Text("${anime.optString("format", "Anime")} • ${anime.optString("status", "Unknown")} • Score ${anime.optString("score", "—")}", color = Muted, fontSize = 12.sp); Spacer(Modifier.height(6.dp)); Text(anime.optString("description", "No synopsis available.").replace(Regex("<[^>]*>"), "").take(420), color = Color.LightGray, fontSize = 13.sp); TextButton2("Add to watchlist") { scope.launch { try { Api.call(base, "/api/library", "POST", JSONObject().put("mediaId", anime.optString("id")).put("title", anime.optString("title")).put("cover", anime.optString("cover")), token); onMessage("Added to your anime list") } catch (e: Exception) { onMessage(e.message ?: "Could not add anime") } } } } } } }
    }
}

@Composable
private fun NewsScreen(base: String, token: String, onMessage: (String) -> Unit) {
    val context = LocalContext.current
    var items by remember { mutableStateOf(listOf<JSONObject>()) }; var loading by remember { mutableStateOf(true) }
    LaunchedEffect(base) { try { val r = Api.call(base, "/api/news", token = token); val a = r.optJSONArray("items") ?: JSONArray(); items = (0 until a.length()).map { a.getJSONObject(it) } } catch (e: Exception) { onMessage(e.message ?: "News unavailable") } finally { loading = false } }
    LazyColumn(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item { Text("Anime News", fontSize = 24.sp, fontWeight = FontWeight.Bold); Text("Latest headlines from anime publishers and news feeds", color = Muted) }
        if (loading) item { LinearProgressIndicator(Modifier.fillMaxWidth()) }
        items(items) { news -> Card(colors = CardDefaults.cardColors(containerColor = Surface), shape = RoundedCornerShape(16.dp), modifier = Modifier.fillMaxWidth()) { Column(Modifier.padding(14.dp)) { Text(news.optString("title", "Anime update"), fontWeight = FontWeight.Bold, fontSize = 17.sp); Text(news.optString("source", "Anime News"), color = Accent, fontSize = 12.sp); Text(news.optString("summary", "Open the source for the full article."), color = Muted, fontSize = 13.sp); TextButton2("Open article") { val u = news.optString("url"); if (u.startsWith("https://")) context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(u))) } } } }
        if (!loading && items.isEmpty()) item { Text("No news loaded yet. Configure ANIME_NEWS_RSS_URL in the backend.", color = Muted) }
    }
}

@Composable
private fun FeedScreen(base: String, token: String, username: String, onMessage: (String) -> Unit) {
    var posts by remember { mutableStateOf(listOf<JSONObject>()) }
    var draft by remember { mutableStateOf("") }
    var loading by remember { mutableStateOf(true) }
    val scope = rememberCoroutineScope()
    suspend fun refresh() {
        val r = Api.call(base, "/api/posts", token = token)
        val a = r.optJSONArray("posts") ?: JSONArray()
        posts = (0 until a.length()).map { a.getJSONObject(it) }
    }
    LaunchedEffect(base) { try { refresh() } catch (e: Exception) { onMessage(e.message ?: "Feed unavailable") } finally { loading = false } }
    Column(Modifier.fillMaxSize().padding(16.dp)) {
        Text("Anime Community", fontSize = 24.sp, fontWeight = FontWeight.Bold)
        Text("Your space to talk about anime", color = Muted)
        Spacer(Modifier.height(12.dp))
        OutlinedTextField(draft, { draft = it }, modifier = Modifier.fillMaxWidth(), label = { Text("What anime is on your mind?") }, minLines = 2)
        Button(onClick = { if (draft.isNotBlank()) scope.launch { try { Api.call(base, "/api/posts", "POST", JSONObject().put("text", draft), token); draft = ""; refresh() } catch (e: Exception) { onMessage(e.message ?: "Post failed") } } }, modifier = Modifier.align(Alignment.End)) { Icon(Icons.Default.Send, null); Spacer(Modifier.width(6.dp)); Text("Post") }
        if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())
        LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            items(posts) { post ->
                var score by remember(post.optString("id")) { mutableIntStateOf(post.optInt("score")) }
                var showComments by remember(post.optString("id")) { mutableStateOf(false) }
                var comments by remember(post.optString("id")) { mutableStateOf(listOf<JSONObject>()) }
                var commentDraft by remember(post.optString("id")) { mutableStateOf("") }
                Card(colors = CardDefaults.cardColors(containerColor = Surface), shape = RoundedCornerShape(16.dp), modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(14.dp)) {
                        Text(post.optString("username", "Anime fan"), color = Accent, fontWeight = FontWeight.Bold)
                        Text(post.optString("createdAt", ""), color = Muted, fontSize = 10.sp)
                        Spacer(Modifier.height(6.dp)); Text(post.optString("text"), fontSize = 15.sp)
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            IconButton(onClick = { scope.launch { try { val r = Api.call(base, "/api/posts/${post.optString("id")}/vote", "POST", JSONObject().put("value", 1), token); score = r.optInt("score", score + 1) } catch (e: Exception) { onMessage(e.message ?: "Vote failed") } } }) { Icon(Icons.Default.KeyboardArrowUp, null, tint = Accent) }
                            Text(score.toString())
                            IconButton(onClick = { scope.launch { try { val r = Api.call(base, "/api/posts/${post.optString("id")}/vote", "POST", JSONObject().put("value", -1), token); score = r.optInt("score", score - 1) } catch (e: Exception) { onMessage(e.message ?: "Vote failed") } } }) { Icon(Icons.Default.KeyboardArrowDown, null, tint = Muted) }
                            TextButton2("${post.optInt("commentCount")} comments") {
                                showComments = true
                                scope.launch { try { val r = Api.call(base, "/api/posts/${post.optString("id")}/comments", token = token); val a = r.optJSONArray("comments") ?: JSONArray(); comments = (0 until a.length()).map { a.getJSONObject(it) } } catch (e: Exception) { onMessage(e.message ?: "Could not load comments") } }
                            }
                        }
                    }
                }
                if (showComments) AlertDialog(
                    onDismissRequest = { showComments = false },
                    title = { Text("Discussion") },
                    text = {
                        Column {
                            LazyColumn(Modifier.heightIn(max = 260.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                items(comments) { c -> Column { Text(c.optString("username", "Anime fan"), color = Accent, fontWeight = FontWeight.Bold); Text(c.optString("text")); Divider(color = Muted.copy(alpha = .2f)) } }
                            }
                            Spacer(Modifier.height(8.dp))
                            OutlinedTextField(commentDraft, { commentDraft = it }, modifier = Modifier.fillMaxWidth(), label = { Text("Write a comment") })
                        }
                    },
                    confirmButton = { TextButton(onClick = { if (commentDraft.isNotBlank()) scope.launch { try { Api.call(base, "/api/posts/${post.optString("id")}/comments", "POST", JSONObject().put("text", commentDraft), token); commentDraft = ""; val r = Api.call(base, "/api/posts/${post.optString("id")}/comments", token = token); val a = r.optJSONArray("comments") ?: JSONArray(); comments = (0 until a.length()).map { a.getJSONObject(it) }; refresh() } catch (e: Exception) { onMessage(e.message ?: "Comment failed") } } }) { Text("Send") } },
                    dismissButton = { TextButton(onClick = { showComments = false }) { Text("Close") } }
                )
            }
        }
    }
}

@Composable
private fun WatchScreen(base: String, token: String, username: String, onMessage: (String) -> Unit) {
    var anime by remember { mutableStateOf("") }; var episode by remember { mutableStateOf("1") }; var anilistId by remember { mutableStateOf("") }; var malId by remember { mutableStateOf("") }; var provider by remember { mutableStateOf("anilist") }; var providerId by remember { mutableStateOf("") }; var providerUsername by remember { mutableStateOf(username) }; var avatar by remember { mutableStateOf("") }; var streamUrl by remember { mutableStateOf("") }; var serverUrl by remember { mutableStateOf("") }; var roomCode by remember { mutableStateOf("") }; var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope(); val context = LocalContext.current
    LazyColumn(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item { Text("Watch Together", fontSize = 24.sp, fontWeight = FontWeight.Bold); Text("Create a Watchium room, then open it in AnymeX.", color = Muted) }
        item { SectionLabel("EPISODE") }
        item { OutlinedTextField(anime, { anime = it }, modifier = Modifier.fillMaxWidth(), label = { Text("Anime title") }) }
        item { OutlinedTextField(episode, { episode = it }, modifier = Modifier.fillMaxWidth(), label = { Text("Episode number") }) }
        item { OutlinedTextField(anilistId, { anilistId = it }, modifier = Modifier.fillMaxWidth(), label = { Text("AniList ID (recommended)") }) }
        item { OutlinedTextField(malId, { malId = it }, modifier = Modifier.fillMaxWidth(), label = { Text("MyAnimeList ID (optional)") }) }
        item { SectionLabel("WATCHIUM ACCOUNT") }
        item { Text("Watchium uses a linked AniList, MyAnimeList or Simkl identity. Use the same provider account that is logged into AnymeX.", color = Muted, fontSize = 12.sp) }
        item { Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { listOf("anilist", "mal", "simkl").forEach { p -> FilterChip(selected = provider == p, onClick = { provider = p }, label = { Text(p.uppercase()) }) } } }
        item { OutlinedTextField(providerId, { providerId = it }, modifier = Modifier.fillMaxWidth(), label = { Text("Provider user ID") }) }
        item { OutlinedTextField(providerUsername, { providerUsername = it }, modifier = Modifier.fillMaxWidth(), label = { Text("Provider username") }) }
        item { OutlinedTextField(avatar, { avatar = it }, modifier = Modifier.fillMaxWidth(), label = { Text("Avatar URL (optional)") }) }
        item { SectionLabel("COMPATIBLE EPISODE STREAM") }
        item { Text("A real room needs a stream URL and any required headers/subtitles. Only use streams you are authorized to access. Localhost/proxy streams cannot be shared.", color = Muted, fontSize = 12.sp) }
        item { OutlinedTextField(serverUrl, { serverUrl = it }, modifier = Modifier.fillMaxWidth(), label = { Text("Stream server label") }) }
        item { OutlinedTextField(streamUrl, { streamUrl = it }, modifier = Modifier.fillMaxWidth(), label = { Text("Direct compatible stream URL") }) }
        item { Button(onClick = {
            if (anime.isBlank() || episode.toIntOrNull() == null || providerId.isBlank() || providerUsername.isBlank() || (anilistId.isBlank() && malId.isBlank()) || streamUrl.isBlank()) { onMessage("Complete the anime title, episode, AniList or MAL ID, provider identity and compatible stream fields first."); return@Button }
            busy = true
            scope.launch { try {
                val body = JSONObject().put("provider", provider).put("providerUserId", providerId).put("username", providerUsername).put("avatarUrl", avatar).put("content", JSONObject().put("animeId", anilistId.ifBlank { malId }).put("animeTitle", anime).put("episodeNumber", episode.toInt()).put("anilistId", anilistId.toIntOrNull()).put("malId", malId.toIntOrNull()).put("availableServers", JSONArray().put(JSONObject().put("serverId", "0").put("serverName", serverUrl.ifBlank { "Default" }).put("url", streamUrl).put("originalUrl", streamUrl).put("type", when { streamUrl.contains(".m3u8", true) -> "hls"; streamUrl.contains(".mpd", true) -> "dash"; streamUrl.contains(".mp4", true) || streamUrl.contains(".mkv", true) -> "mp4"; else -> "other" }))))
                val result = Api.call(base, "/api/watchium/rooms", "POST", body, token)
                roomCode = result.optString("code")
                if (roomCode.length == 6) { val intent = Intent(Intent.ACTION_VIEW, Uri.parse("anymex://watchium/join/$roomCode")); if (intent.resolveActivity(context.packageManager) != null) context.startActivity(intent) else onMessage("Room $roomCode created. Install AnymeX to join it.") } else onMessage("Watchium did not return a valid room code.")
            } catch (e: Exception) { onMessage(e.message ?: "Room creation failed") } finally { busy = false } }
        }, modifier = Modifier.fillMaxWidth(), enabled = !busy) { Text(if (busy) "Creating room…" else "Create room and open AnymeX") } }
        if (roomCode.isNotBlank()) item { Card(colors = CardDefaults.cardColors(containerColor = Surface)) { Column(Modifier.padding(16.dp)) { Text("Room created", color = Accent, fontWeight = FontWeight.Bold); Text(roomCode, fontSize = 28.sp, fontWeight = FontWeight.ExtraBold); TextButton2("Open in AnymeX") { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("anymex://watchium/join/$roomCode"))) } } } }
    }
}

@Composable private fun SectionLabel(text: String) { Text(text, color = Accent, fontWeight = FontWeight.Bold, fontSize = 11.sp, letterSpacing = 1.5.sp) }

@Composable
private fun ProfileScreen(username: String, baseUrl: String, onBaseUrl: (String) -> Unit, onLogout: () -> Unit) {
    var url by remember { mutableStateOf(baseUrl) }
    Column(Modifier.fillMaxSize().padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Profile", fontSize = 24.sp, fontWeight = FontWeight.Bold); Text(username, color = Accent, fontSize = 20.sp, fontWeight = FontWeight.Bold)
        Text("Backend settings", color = Muted); OutlinedTextField(url, { url = it }, modifier = Modifier.fillMaxWidth(), label = { Text("Backend base URL") })
        Button(onClick = { onBaseUrl(url) }) { Text("Save server URL") }
        OutlinedButton(onClick = onLogout) { Text("Log out") }
        Text("Anime Friends is anime-only. Manga features are intentionally not included.", color = Muted, fontSize = 12.sp)
    }
}
